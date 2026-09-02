import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ServiceProductDefault,
  ServiceProductDefaultDocument,
} from './schemas/service-product-default.schema';
import {
  Inventory,
  InventoryDocument,
  InventoryCategory,
} from '../inventory/schemas/inventory.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { ServiceProductSlot } from './models/service-product-slot.model';
import { SetServiceProductDefaultInput } from './dto/set-service-product-default.input';

@Injectable()
export class WasherServiceProductsService {
  constructor(
    @InjectModel(ServiceProductDefault.name)
    private readonly defaultModel: Model<ServiceProductDefaultDocument>,
    @InjectModel(Inventory.name)
    private readonly inventoryModel: Model<InventoryDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
  ) {}

  private async findActiveProductsInCategory(
    branchId: string,
    category: string,
  ): Promise<Product[]> {
    const inventoryIds = await this.inventoryModel
      .find({ branchId, inventoryCategory: category, isArchived: false } as any)
      .distinct('_id')
      .exec();
    if (inventoryIds.length === 0) return [];
    return this.productModel
      .find({
        inventoryId: { $in: inventoryIds },
        isActive: true,
        isArchived: false,
      })
      .exec();
  }

  async setDefault(
    branchId: string,
    input: SetServiceProductDefaultInput,
  ): Promise<ServiceProductDefault> {
    const candidates = await this.findActiveProductsInCategory(
      branchId,
      input.category,
    );
    const belongs = candidates.some(
      (p) => String(p._id) === String(input.productId),
    );
    if (!belongs) {
      throw new BadRequestException(
        "That product does not belong to this branch's stock in the given category.",
      );
    }

    return this.defaultModel
      .findOneAndUpdate(
        {
          branchId,
          serviceTemplateId: input.serviceTemplateId,
          category: input.category,
        },
        { $set: { defaultProductId: input.productId } },
        { upsert: true, new: true },
      )
      .exec();
  }

  async removeDefault(
    branchId: string,
    serviceTemplateId: string,
    category: InventoryCategory,
  ): Promise<boolean> {
    const result = await this.defaultModel
      .deleteOne({ branchId, serviceTemplateId, category })
      .exec();
    if (result.deletedCount === 0) {
      throw new NotFoundException('No default configured for that slot');
    }
    return true;
  }

  async getSlotsForService(
    branchId: string,
    serviceTemplateId: string,
  ): Promise<ServiceProductSlot[]> {
    const defaults = await this.defaultModel
      .find({ branchId, serviceTemplateId })
      .exec();

    const slots: ServiceProductSlot[] = [];
    for (const def of defaults) {
      const candidates = await this.findActiveProductsInCategory(
        branchId,
        def.category,
      );
      const defaultProduct = candidates.find(
        (p) => String(p._id) === String(def.defaultProductId),
      );
      if (!defaultProduct) continue; // default was archived/removed since being set

      slots.push({
        category: def.category,
        defaultProduct,
        alternativeProducts: candidates.filter(
          (p) => String(p._id) !== String(def.defaultProductId),
        ),
      });
    }
    return slots;
  }
}
