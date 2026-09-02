import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Inventory, InventoryDocument } from './schemas/inventory.schema';
import {
  InventoryTransaction,
  InventoryTransactionDocument,
  TransactionType,
} from './schemas/inventory-transaction.schema';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { Service, ServiceDocument } from '../services/schemas/service.schema';
import { CreateInventoryInput } from './dto/create-inventory.input';
import { UpdateInventoryInput } from './dto/update-inventory.input';
import { RestockInventoryInput } from './dto/restock-inventory.input';
import { AdjustInventoryInput } from './dto/adjust-inventory.input';
import { DamageInventoryInput } from './dto/damage-inventory.input';
import { InventoryFilterInput } from './dto/inventory-filter.input';
import { TransactionFilterInput } from './dto/transaction-filter.input';
import { PaginatedInventory } from './models/paginated-inventory.model';
import { PaginatedTransactions } from './models/paginated-transactions.model';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';
import { applyBranchScope } from '../common/scoping/tenant-scope';

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    @InjectModel(Inventory.name)
    private readonly inventoryModel: Model<InventoryDocument>,
    @InjectModel(InventoryTransaction.name)
    private readonly transactionModel: Model<InventoryTransactionDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Service.name)
    private readonly serviceModel: Model<ServiceDocument>,
  ) {}

  private getRole(user: User): Role {
    return user.role as unknown as Role;
  }

  private getMerchantId(user: User): string {
    const role = this.getRole(user);
    return role?.roleId === 'staff' ? user.merchantId! : user._id;
  }

  private getCreatedByType(user: User): string {
    return this.getRole(user)?.roleId ?? 'unknown';
  }

  private async validateBranchAccess(
    branchId: string,
    user: User,
  ): Promise<void> {
    const merchantId = this.getMerchantId(user);
    const branch = await this.branchModel.findById(branchId).exec();

    if (!branch || branch.uid !== merchantId) {
      throw new BadRequestException(
        'Branch not found or does not belong to you',
      );
    }
    if (!branch.isActive) {
      throw new BadRequestException('Branch is inactive');
    }

    const role = this.getRole(user);
    if (role?.roleId === 'staff') {
      const staffBranchIds = (user.branchIds as unknown as string[]) ?? [];
      const hasAccess = staffBranchIds.some(
        (id) => id.toString() === branch._id.toString(),
      );
      if (!hasAccess) {
        throw new BadRequestException('You are not assigned to this branch');
      }
    }
  }

  private async logTransaction(
    inventoryId: string,
    type: TransactionType,
    quantityChange: number,
    user: User,
  ): Promise<void> {
    const txDoc: any = {
      inventoryId,
      type,
      quantityChange,
      createdBy: user._id,
      createdByType: this.getCreatedByType(user),
    };
    await this.transactionModel.create(txDoc);
  }

  async create(input: CreateInventoryInput, user: User): Promise<Inventory> {
    await this.validateBranchAccess(input.branchId, user);
    const uid = this.getMerchantId(user);
    const inventory = new this.inventoryModel({ ...input, uid });
    return inventory.save();
  }

  async findAll(
    uid: string,
    allowedBranchIds: string[] | null,
    filter: InventoryFilterInput = {},
  ): Promise<PaginatedInventory> {
    const {
      branchId,
      search,
      inventoryCategory,
      isArchived,
      isActive,
      limit = 10,
      offset = 0,
    } = filter;
    const safeLimit = Math.min(limit ?? 10, 100);
    const query: Record<string, any> = { uid };
    applyBranchScope(query, { merchantId: uid, allowedBranchIds }, branchId);
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.productName = { $regex: escaped, $options: 'i' };
    }
    if (inventoryCategory) query.inventoryCategory = inventoryCategory;
    if (isArchived !== undefined) query.isArchived = isArchived;
    if (isActive !== undefined) query.isActive = isActive;

    const [data, total] = await Promise.all([
      this.inventoryModel.find(query).skip(offset).limit(safeLimit).exec(),
      this.inventoryModel.countDocuments(query).exec(),
    ]);
    return { data, total, limit: safeLimit, offset };
  }

  async findById(id: string, uid: string): Promise<Inventory> {
    const inventory = await this.inventoryModel
      .findOne({ _id: new Types.ObjectId(id), uid } as any)
      .exec();
    if (!inventory) throw new NotFoundException('Inventory item not found');
    return inventory;
  }

  async update(
    id: string,
    uid: string,
    input: UpdateInventoryInput,
  ): Promise<Inventory> {
    const inventory = await this.inventoryModel
      .findOne({ _id: new Types.ObjectId(id), uid } as any)
      .exec();
    if (!inventory) throw new NotFoundException('Inventory item not found');
    const updated = await this.inventoryModel
      .findByIdAndUpdate(id, { $set: input }, { new: true })
      .exec();
    return updated!;
  }

  async restock(
    id: string,
    uid: string,
    input: RestockInventoryInput,
    user: User,
  ): Promise<Inventory> {
    const inventory = await this.inventoryModel
      .findOne({ _id: new Types.ObjectId(id), uid } as any)
      .exec();
    if (!inventory) throw new NotFoundException('Inventory item not found');
    if (inventory.isArchived)
      throw new BadRequestException('Cannot modify an archived inventory item');
    const updated = await this.inventoryModel
      .findByIdAndUpdate(
        id,
        { $inc: { stockQuantity: input.quantity } },
        { new: true },
      )
      .exec();
    await this.logTransaction(
      id,
      TransactionType.RESTOCK,
      input.quantity,
      user,
    );
    this.logger.log(
      `Restock: ${inventory.productName} | +${input.quantity} | newStock=${updated!.stockQuantity} | reason="${input.reason ?? ''}" | by=${user._id}`,
    );
    return updated!;
  }

  async adjust(
    id: string,
    uid: string,
    input: AdjustInventoryInput,
    user: User,
  ): Promise<Inventory> {
    const inventory = await this.inventoryModel
      .findOne({ _id: new Types.ObjectId(id), uid } as any)
      .exec();
    if (!inventory) throw new NotFoundException('Inventory item not found');
    if (inventory.isArchived)
      throw new BadRequestException('Cannot modify an archived inventory item');
    const newQty = inventory.stockQuantity + input.quantityChange;
    if (newQty < 0)
      throw new BadRequestException(
        'Adjustment would result in negative stock quantity',
      );
    const updated = await this.inventoryModel
      .findByIdAndUpdate(
        id,
        { $inc: { stockQuantity: input.quantityChange } },
        { new: true },
      )
      .exec();
    await this.logTransaction(
      id,
      TransactionType.ADJUSTMENT,
      input.quantityChange,
      user,
    );
    this.logger.warn(
      `Adjustment: ${inventory.productName} | ${input.quantityChange > 0 ? '+' : ''}${input.quantityChange} | newStock=${updated!.stockQuantity} | reason="${input.reason}" | by=${user._id}`,
    );
    return updated!;
  }

  async damage(
    id: string,
    uid: string,
    input: DamageInventoryInput,
    user: User,
  ): Promise<Inventory> {
    const inventory = await this.inventoryModel
      .findOne({ _id: new Types.ObjectId(id), uid } as any)
      .exec();
    if (!inventory) throw new NotFoundException('Inventory item not found');
    if (inventory.isArchived)
      throw new BadRequestException('Cannot modify an archived inventory item');
    if (inventory.stockQuantity < input.quantity) {
      throw new BadRequestException(
        `Cannot damage ${input.quantity} — only ${inventory.stockQuantity} in stock`,
      );
    }
    const updated = await this.inventoryModel
      .findByIdAndUpdate(
        id,
        { $inc: { stockQuantity: -input.quantity } },
        { new: true },
      )
      .exec();
    await this.logTransaction(
      id,
      TransactionType.DAMAGE,
      -input.quantity,
      user,
    );
    this.logger.warn(
      `Damage: ${inventory.productName} | -${input.quantity} | newStock=${updated!.stockQuantity} | reason="${input.reason}" | by=${user._id}`,
    );
    return updated!;
  }

  async archive(id: string, uid: string): Promise<Inventory> {
    const inventory = await this.inventoryModel
      .findOne({ _id: new Types.ObjectId(id), uid } as any)
      .exec();
    if (!inventory) throw new NotFoundException('Inventory item not found');
    if (inventory.isArchived)
      throw new BadRequestException('Inventory item is already archived');
    const activeProductCount = await this.productModel
      .countDocuments({ inventoryId: id, isArchived: false })
      .exec();
    if (activeProductCount > 0)
      throw new BadRequestException(
        `Cannot archive — ${activeProductCount} active product(s) still use this inventory item. Archive those products first.`,
      );
    const activeServiceCount = await this.serviceModel
      .countDocuments({
        uid,
        isArchived: false,
        'defaultProducts.inventoryId': id,
      })
      .exec();
    if (activeServiceCount > 0)
      throw new BadRequestException(
        `Cannot archive — ${activeServiceCount} active service(s) still consume this inventory item. Remove it from those services first.`,
      );
    const updated = await this.inventoryModel
      .findByIdAndUpdate(
        id,
        { $set: { isArchived: true, archivedAt: new Date() } },
        { new: true },
      )
      .exec();
    return updated!;
  }

  async restore(id: string, uid: string): Promise<Inventory> {
    const inventory = await this.inventoryModel
      .findOne({ _id: new Types.ObjectId(id), uid } as any)
      .exec();
    if (!inventory) throw new NotFoundException('Inventory item not found');
    if (!inventory.isArchived)
      throw new BadRequestException('Inventory item is not archived');
    const updated = await this.inventoryModel
      .findByIdAndUpdate(
        id,
        { $set: { isArchived: false, archivedAt: null } },
        { new: true },
      )
      .exec();
    return updated!;
  }

  async getTransactions(
    inventoryId: string,
    uid: string,
  ): Promise<InventoryTransaction[]> {
    const inventory = await this.inventoryModel
      .findOne({ _id: new Types.ObjectId(inventoryId), uid } as any)
      .exec();
    if (!inventory) throw new NotFoundException('Inventory item not found');
    const txFilter: any = { inventoryId };
    return this.transactionModel.find(txFilter).sort({ createdAt: -1 }).exec();
  }

  async findAllTransactions(
    uid: string,
    filter: TransactionFilterInput = {},
  ): Promise<PaginatedTransactions> {
    const {
      inventoryId,
      branchId,
      type,
      createdBy,
      createdByType,
      limit = 10,
      offset = 0,
    } = filter;
    const safeLimit = Math.min(limit ?? 10, 100);
    const query: any = {};

    if (inventoryId) {
      const ownedInventory = await this.inventoryModel
        .findOne({ _id: new Types.ObjectId(inventoryId), uid } as any)
        .exec();
      if (!ownedInventory)
        throw new NotFoundException('Inventory item not found');
      query.inventoryId = inventoryId;
    } else {
      const inventoryQuery: any = { uid };
      if (branchId) inventoryQuery.branchId = branchId;
      const inventoryItems = await this.inventoryModel
        .find(inventoryQuery)
        .select('_id')
        .lean()
        .exec();
      query.inventoryId = { $in: inventoryItems.map((i) => i._id) };
    }

    if (type) query.type = type;
    if (createdBy) query.createdBy = createdBy;
    if (createdByType) query.createdByType = createdByType;

    const [data, total] = await Promise.all([
      this.transactionModel
        .find(query)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(safeLimit)
        .exec(),
      this.transactionModel.countDocuments(query).exec(),
    ]);
    return { data, total, limit: safeLimit, offset };
  }
}
