import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Service, ServiceDocument } from './schemas/service.schema';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import {
  Inventory,
  InventoryDocument,
} from '../inventory/schemas/inventory.schema';
import {
  PosOrder,
  PosOrderDocument,
} from '../pos_orders/schemas/pos-order.schema';
import { CreateServiceInput } from './dto/create-service.input';
import { UpdateServiceInput } from './dto/update-service.input';
import { ServiceFilterInput } from './dto/service-filter.input';
import { PaginatedServices } from './models/paginated-services.model';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';
import {
  applyBranchScope,
  resolveTenantScope,
} from '../common/scoping/tenant-scope';

@Injectable()
export class ServicesService {
  constructor(
    @InjectModel(Service.name)
    private readonly serviceModel: Model<ServiceDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    @InjectModel(Inventory.name)
    private readonly inventoryModel: Model<InventoryDocument>,
    @InjectModel(PosOrder.name)
    private readonly posOrderModel: Model<PosOrderDocument>,
  ) {}

  private getRole(user: User): Role {
    return user.role as unknown as Role;
  }

  getMerchantId(user: User): string {
    const role = this.getRole(user);
    return role?.roleId === 'staff' ? user.merchantId! : user._id;
  }

  /**
   * Branches this caller may read, or `null` for an owner — who is not branch
   * restricted at all. SEC-016: the old signature returned `[]` for BOTH an
   * owner and a staff member with no assignment, and the query builders read
   * that as "no constraint", so an unassigned staff silently got merchant-wide
   * visibility. `null` vs `[]` is now the difference between the two.
   */
  getBranchIds(user: User, activeBranchId?: string | null): string[] | null {
    // SEC-016/M6 — delegates to the canonical resolver. `null` means an owner,
    // who is not branch restricted; `[]` means staff with no assignment, who
    // must see nothing. The two were indistinguishable before.
    return resolveTenantScope(user, activeBranchId).allowedBranchIds;
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
    if (!branch.isActive) throw new BadRequestException('Branch is inactive');
    const role = this.getRole(user);
    if (role?.roleId === 'staff') {
      const staffBranchIds = (user.branchIds as unknown as string[]) ?? [];
      const hasAccess = staffBranchIds.some(
        (id) => id.toString() === branch._id.toString(),
      );
      if (!hasAccess)
        throw new BadRequestException('You are not assigned to this branch');
    }
  }

  private async validateDefaultProducts(
    defaultProducts: {
      inventoryId: string;
      productName: string;
      quantity: number;
    }[],
    uid: string,
  ): Promise<void> {
    for (const dp of defaultProducts) {
      const inventory = await this.inventoryModel
        .findOne({ _id: new Types.ObjectId(dp.inventoryId), uid } as any)
        .exec();
      if (!inventory)
        throw new BadRequestException(
          'One or more default products in this service could not be found.',
        );
      if (inventory.isArchived)
        throw new BadRequestException(
          `Inventory item "${inventory.productName}" is archived`,
        );
    }
  }

  private async checkServiceCodeUnique(
    branchId: string,
    serviceCode: string,
    excludeId?: string,
  ): Promise<void> {
    const query: any = { branchId, serviceCode: serviceCode.toUpperCase() };
    if (excludeId) query._id = { $ne: new Types.ObjectId(excludeId) };
    const existing = await this.serviceModel.findOne(query).exec();
    if (existing)
      throw new BadRequestException(
        `Service code "${serviceCode}" is already used in this branch`,
      );
  }

  private async checkServiceNameUnique(
    branchId: string,
    serviceName: string,
    excludeId?: string,
  ): Promise<void> {
    const escaped = serviceName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const query: any = {
      branchId,
      isArchived: false,
      serviceName: { $regex: `^${escaped}$`, $options: 'i' },
    };
    if (excludeId) query._id = { $ne: new Types.ObjectId(excludeId) };
    const existing = await this.serviceModel.findOne(query).exec();
    if (existing)
      throw new BadRequestException(
        `A service or add-on already exists in this branch`,
      );
  }

  async create(input: CreateServiceInput, user: User): Promise<Service> {
    await this.validateBranchAccess(input.branchId, user);
    const uid = this.getMerchantId(user);
    if (input.serviceCode)
      await this.checkServiceCodeUnique(input.branchId, input.serviceCode);
    await this.checkServiceNameUnique(input.branchId, input.serviceName);
    if (input.defaultProducts?.length)
      await this.validateDefaultProducts(input.defaultProducts, uid);
    const service = new this.serviceModel({ ...input, uid });
    return service.save();
  }

  async findAll(
    uid: string,
    allowedBranchIds: string[] | null,
    filter: ServiceFilterInput = {},
  ): Promise<PaginatedServices> {
    const {
      branchId,
      search,
      category,
      pricingType,
      isActive,
      isArchived,
      limit = 10,
      offset = 0,
    } = filter;
    const query: Record<string, any> = { uid, branchId: { $ne: null } };
    applyBranchScope(query, { merchantId: uid, allowedBranchIds }, branchId);
    if (search)
      query.serviceName = {
        $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        $options: 'i',
      };
    if (category) query.category = category;
    if (pricingType) query.pricingType = pricingType;
    if (isActive !== undefined) query.isActive = isActive;
    if (isArchived !== undefined) query.isArchived = isArchived;
    const [data, total] = await Promise.all([
      this.serviceModel.find(query).skip(offset).limit(limit).exec(),
      this.serviceModel.countDocuments(query).exec(),
    ]);
    return { data, total, limit, offset };
  }

  async findById(id: string): Promise<Service> {
    const service = await this.serviceModel.findById(id).exec();
    if (!service) throw new NotFoundException('Service not found');
    return service;
  }

  async update(
    id: string,
    user: User,
    input: UpdateServiceInput,
  ): Promise<Service> {
    const uid = this.getMerchantId(user);
    const service = await this.serviceModel
      .findOne({ _id: new Types.ObjectId(id), uid } as any)
      .exec();
    if (!service) throw new NotFoundException('Service not found');
    if (input.serviceCode)
      await this.checkServiceCodeUnique(
        service.branchId,
        input.serviceCode,
        id,
      );
    if (input.serviceName)
      await this.checkServiceNameUnique(
        service.branchId,
        input.serviceName,
        id,
      );
    if (input.defaultProducts?.length)
      await this.validateDefaultProducts(input.defaultProducts, uid);
    const updated = await this.serviceModel
      .findByIdAndUpdate(id, { $set: input }, { new: true })
      .exec();
    return updated!;
  }

  async archive(id: string, uid: string): Promise<Service> {
    const service = await this.serviceModel
      .findOne({ _id: new Types.ObjectId(id), uid } as any)
      .exec();
    if (!service) throw new NotFoundException('Service not found');
    if (service.isArchived)
      throw new BadRequestException('Service is already archived');
    const updated = await this.serviceModel
      .findByIdAndUpdate(
        id,
        { $set: { isArchived: true, archivedAt: new Date() } },
        { new: true },
      )
      .exec();
    return updated!;
  }

  async restore(id: string, uid: string): Promise<Service> {
    const service = await this.serviceModel
      .findOne({ _id: new Types.ObjectId(id), uid } as any)
      .exec();
    if (!service) throw new NotFoundException('Service not found');
    if (!service.isArchived)
      throw new BadRequestException('Service is not archived');
    const updated = await this.serviceModel
      .findByIdAndUpdate(
        id,
        { $set: { isArchived: false, archivedAt: null } },
        { new: true },
      )
      .exec();
    return updated!;
  }

  async delete(id: string, uid: string): Promise<Service> {
    const service = await this.serviceModel
      .findOne({ _id: new Types.ObjectId(id), uid } as any)
      .exec();
    if (!service) throw new NotFoundException('Service not found');
    // Check if any non-terminal orders reference this service
    const activeOrderCount = await this.posOrderModel
      .countDocuments({
        'items.serviceId': id,
        laundryStatus: { $nin: ['completed', 'cancelled', 'void'] },
      } as any)
      .exec();
    if (activeOrderCount > 0) {
      throw new BadRequestException(
        `Cannot delete this service: it is referenced by ${activeOrderCount} active order(s). Complete or cancel those orders first.`,
      );
    }
    await this.serviceModel.findByIdAndDelete(id).exec();
    return service; // return the deleted service (FE only needs _id)
  }
}
