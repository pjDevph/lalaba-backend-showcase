import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Product, ProductDocument } from './schemas/product.schema';
import {
  Inventory,
  InventoryDocument,
} from '../inventory/schemas/inventory.schema';
import { CreateProductInput } from './dto/create-product.input';
import { UpdateProductInput } from './dto/update-product.input';
import { ProductFilterInput } from './dto/product-filter.input';
import { PaginatedProducts } from './models/paginated-products.model';
import { applyBranchScope } from '../common/scoping/tenant-scope';

@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Inventory.name)
    private readonly inventoryModel: Model<InventoryDocument>,
  ) {}

  private async checkProductNameUnique(
    branchId: string,
    uid: string,
    productName: string,
    excludeId?: string,
  ): Promise<void> {
    const inventoryIds = (
      await this.inventoryModel
        .find({ uid, branchId } as any)
        .select('_id')
        .exec()
    ).map((doc) => doc._id);
    const escaped = productName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const query: any = {
      inventoryId: { $in: inventoryIds },
      isArchived: false,
      productName: { $regex: `^${escaped}$`, $options: 'i' },
    };
    if (excludeId) query._id = { $ne: new Types.ObjectId(excludeId) };
    const existing = await this.productModel.findOne(query).exec();
    if (existing)
      throw new BadRequestException(
        `A product named "${productName}" already exists in this branch`,
      );
  }

  async create(input: CreateProductInput, uid: string): Promise<Product> {
    const inventory = await this.inventoryModel
      .findOne({
        _id: new Types.ObjectId(input.inventoryId),
        uid,
      } as any)
      .exec();
    if (!inventory)
      throw new NotFoundException(
        'Inventory item not found or does not belong to you',
      );
    if (inventory.isArchived)
      throw new BadRequestException(
        'Cannot add product to an archived inventory item',
      );
    await this.checkProductNameUnique(
      inventory.branchId,
      uid,
      input.productName,
    );
    const product = new this.productModel({
      ...input,
      inventoryId: new Types.ObjectId(input.inventoryId),
    });
    return product.save();
  }

  async findAll(
    uid: string,
    allowedBranchIds: string[] | null,
    filter: ProductFilterInput = {},
  ): Promise<PaginatedProducts> {
    const {
      branchId,
      search,
      productCategory,
      isArchived,
      isActive,
      limit = 10,
      offset = 0,
    } = filter;
    const safeLimit = Math.min(limit ?? 10, 100);

    const inventoryQuery: Record<string, any> = { uid };
    applyBranchScope(
      inventoryQuery,
      { merchantId: uid, allowedBranchIds },
      branchId,
    );
    const inventoryIds = (
      await this.inventoryModel.find(inventoryQuery).select('_id').exec()
    ).map((doc) => doc._id);

    const query: Record<string, any> = { inventoryId: { $in: inventoryIds } };
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.productName = { $regex: escaped, $options: 'i' };
    }
    if (productCategory) query.productCategory = productCategory;
    if (isArchived !== undefined) query.isArchived = isArchived;
    if (isActive !== undefined) query.isActive = isActive;

    const [data, total] = await Promise.all([
      this.productModel.find(query).skip(offset).limit(safeLimit).exec(),
      this.productModel.countDocuments(query).exec(),
    ]);
    return { data, total, limit: safeLimit, offset };
  }

  async findByInventory(inventoryId: string, uid: string): Promise<Product[]> {
    const inventory = await this.inventoryModel
      .findOne({ _id: inventoryId, uid } as any)
      .exec();
    if (!inventory)
      throw new NotFoundException(
        'Inventory item not found or does not belong to you',
      );
    const filter: any = { inventoryId, isArchived: false };
    return this.productModel.find(filter).exec();
  }

  async findById(id: string, uid: string): Promise<Product> {
    const product = await this.productModel.findById(id).exec();
    if (!product) throw new NotFoundException('Product not found');
    // Product has no uid of its own — ownership is only verifiable via the
    // linked Inventory item, which is uid-scoped.
    const inventory = await this.inventoryModel
      .findOne({ _id: product.inventoryId, uid } as any)
      .exec();
    if (!inventory) throw new NotFoundException('Product not found');
    return product;
  }

  async update(
    id: string,
    uid: string,
    input: UpdateProductInput,
  ): Promise<Product> {
    const product = await this.productModel.findById(id).exec();
    if (!product) throw new NotFoundException('Product not found');
    const inventory = await this.inventoryModel
      .findOne({ _id: product.inventoryId, uid } as any)
      .exec();
    if (!inventory)
      throw new NotFoundException(
        'Product not found or does not belong to you',
      );
    if (input.productName)
      await this.checkProductNameUnique(
        inventory.branchId,
        uid,
        input.productName,
        id,
      );
    const updated = await this.productModel
      .findByIdAndUpdate(id, { $set: input }, { new: true })
      .exec();
    return updated!;
  }

  async archive(id: string, uid: string): Promise<Product> {
    const product = await this.productModel.findById(id).exec();
    if (!product) throw new NotFoundException('Product not found');
    const inventory = await this.inventoryModel
      .findOne({ _id: product.inventoryId, uid } as any)
      .exec();
    if (!inventory)
      throw new NotFoundException(
        'Product not found or does not belong to you',
      );
    if (product.isArchived)
      throw new BadRequestException('Product is already archived');
    const updated = await this.productModel
      .findByIdAndUpdate(
        id,
        { $set: { isArchived: true, archivedAt: new Date() } },
        { new: true },
      )
      .exec();
    return updated!;
  }

  async restore(id: string, uid: string): Promise<Product> {
    const product = await this.productModel.findById(id).exec();
    if (!product) throw new NotFoundException('Product not found');
    const inventory = await this.inventoryModel
      .findOne({ _id: product.inventoryId, uid } as any)
      .exec();
    if (!inventory)
      throw new NotFoundException(
        'Product not found or does not belong to you',
      );
    if (!product.isArchived)
      throw new BadRequestException('Product is not archived');
    const updated = await this.productModel
      .findByIdAndUpdate(
        id,
        { $set: { isArchived: false, archivedAt: null } },
        { new: true },
      )
      .exec();
    return updated!;
  }
}
