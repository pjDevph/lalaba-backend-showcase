import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import {
  PosOrder,
  PosOrderDocument,
  PaymentStatus,
  LaundryStatus,
  DiscountType,
  OrderItemType,
  FulfillmentType,
  OrderItem,
  DefaultProductItem,
} from './schemas/pos-order.schema';
import {
  PosTransaction,
  PosTransactionDocument,
  TransactionStatus,
} from '../pos_transactions/schemas/pos-transaction.schema';
import {
  Service,
  ServiceDocument,
  PricingType,
  DefaultProductPer,
} from '../services/schemas/service.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import {
  Inventory,
  InventoryDocument,
} from '../inventory/schemas/inventory.schema';
import { convertQuantity } from '../inventory/utils/unit-conversion';
import {
  InventoryTransaction,
  InventoryTransactionDocument,
  TransactionType,
} from '../inventory/schemas/inventory-transaction.schema';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import { holdsOnBranch } from '../permissions/branch-permission-check';
import {
  Permission,
  PermissionDocument,
} from '../permissions/schemas/permission.schema';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';
import { CreateOrderInput, OrderItemInput } from './dto/create-order.input';
import { ProcessPaymentInput } from './dto/process-payment.input';
import { OrderFilterInput } from './dto/order-filter.input';
import { PaginatedOrders } from './models/paginated-orders.model';
import { Receipt } from './models/receipt.model';
import {
  applyBranchScope,
  resolveTenantScope,
} from '../common/scoping/tenant-scope';

@Injectable()
export class PosOrdersService {
  private readonly logger = new Logger(PosOrdersService.name);

  constructor(
    @InjectModel(PosOrder.name)
    private readonly orderModel: Model<PosOrderDocument>,
    @InjectModel(PosTransaction.name)
    private readonly txModel: Model<PosTransactionDocument>,
    @InjectModel(Service.name)
    private readonly serviceModel: Model<ServiceDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Inventory.name)
    private readonly inventoryModel: Model<InventoryDocument>,
    @InjectModel(InventoryTransaction.name)
    private readonly invTxModel: Model<InventoryTransactionDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    @InjectModel(Permission.name)
    private readonly permissionModel: Model<PermissionDocument>,
    @InjectConnection()
    private readonly connection: Connection,
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

  private generateClaimCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[randomInt(chars.length)];
    return code;
  }

  private async getUniqueClaimCode(): Promise<string> {
    let code: string;
    let exists: boolean;
    do {
      code = this.generateClaimCode();
      exists = !!(await this.orderModel.findOne({ claimCode: code }).exec());
    } while (exists);
    return code!;
  }

  private calculateItemSubtotal(
    item: OrderItemInput,
    service?: Service,
  ): number {
    if (item.type === OrderItemType.product) {
      return 0;
    }
    if (!service) return 0;
    const qty = item.quantity;
    const price = service.price;
    switch (service.pricingType) {
      case PricingType.PER_KILO:
      case PricingType.PER_PIECE:
        return qty * price;
      case PricingType.PER_LOAD:
        return qty * price;
      case PricingType.PER_KILO_WITH_BASE:
        if (qty <= (service.baseKilos ?? 0)) return price;
        return (
          price + (qty - (service.baseKilos ?? 0)) * (service.excessRate ?? 0)
        );
      default:
        return qty * price;
    }
  }

  private calculateDiscount(
    subtotal: number,
    discountType?: DiscountType,
    discountValue?: number,
  ): number {
    if (!discountType || discountValue == null) return 0;
    if (discountType === DiscountType.flat)
      return Math.min(discountValue, subtotal);
    const capped = Math.min(discountValue, 100);
    const raw = Math.round(subtotal * (capped / 100) * 100) / 100;
    return Math.min(raw, subtotal);
  }

  private async adjustServiceItemStock(
    dp: DefaultProductItem,
    uid: string,
    user: string,
    createdByType: string,
    txType: TransactionType,
    signedQuantity: number,
    session?: ClientSession,
  ): Promise<void> {
    const inventory = await this.inventoryModel
      .findOne({ _id: new Types.ObjectId(dp.inventoryId), uid } as any)
      .session(session ?? null)
      .exec();
    if (!inventory) return;
    const delta = convertQuantity(
      signedQuantity,
      dp.unit,
      inventory.inventoryUnit,
    );
    const filter: any = { _id: inventory._id, uid };
    if (delta < 0) filter.stockQuantity = { $gte: -delta };
    const updated = await this.inventoryModel
      .findOneAndUpdate(filter, { $inc: { stockQuantity: delta } }, { session })
      .exec();
    if (!updated) {
      throw new BadRequestException(
        `Insufficient stock for "${inventory.productName}". Needed ${Math.abs(delta)} ${inventory.inventoryUnit}, but only ${inventory.stockQuantity} ${inventory.inventoryUnit} available.`,
      );
    }
    await this.invTxModel.create(
      [
        {
          inventoryId: dp.inventoryId,
          type: txType,
          quantityChange: delta,
          createdBy: user,
          createdByType,
        },
      ],
      { session },
    );
  }

  private async adjustProductItemStock(
    item: OrderItem,
    uid: string,
    userId: string,
    createdByType: string,
    txType: TransactionType,
    session?: ClientSession,
  ): Promise<void> {
    // Product has no uid of its own — ownership already verified upstream
    // (resolveProductItem) via the linked Inventory item's uid.
    const product = await this.productModel
      .findById(item.productId)
      .session(session ?? null)
      .exec();
    if (!product) return;
    const inventory = await this.inventoryModel
      .findOne({ _id: product.inventoryId, uid } as any)
      .session(session ?? null)
      .exec();
    if (!inventory) return;
    const perUnitQty = convertQuantity(
      product.quantity,
      product.productUnit,
      inventory.inventoryUnit,
    );
    const magnitude = perUnitQty * item.quantity;
    const delta = txType === TransactionType.CONSUME ? -magnitude : magnitude;
    const filter: any = { _id: inventory._id, uid };
    if (delta < 0) filter.stockQuantity = { $gte: -delta };
    const updated = await this.inventoryModel
      .findOneAndUpdate(filter, { $inc: { stockQuantity: delta } }, { session })
      .exec();
    if (!updated) {
      throw new BadRequestException(
        `Insufficient stock for "${inventory.productName}". Needed ${Math.abs(delta)} ${inventory.inventoryUnit}, but only ${inventory.stockQuantity} ${inventory.inventoryUnit} available.`,
      );
    }
    await this.invTxModel.create(
      [
        {
          inventoryId: inventory._id.toString(),
          type: txType,
          quantityChange: delta,
          createdBy: userId,
          createdByType,
        },
      ],
      { session },
    );
  }

  private async deductInventory(
    items: OrderItem[],
    uid: string,
    user: User,
    session?: ClientSession,
  ): Promise<void> {
    const createdByType = this.getRole(user)?.roleId ?? 'unknown';
    for (const item of items) {
      if (item.type === OrderItemType.service && item.defaultProducts?.length) {
        for (const dp of item.defaultProducts) {
          if (!dp.included) continue;
          const multiplier =
            dp.per && dp.per !== DefaultProductPer.order ? item.quantity : 1;
          await this.adjustServiceItemStock(
            dp,
            uid,
            user._id,
            createdByType,
            TransactionType.CONSUME,
            -dp.quantity * multiplier,
            session,
          );
        }
      }
      if (item.type === OrderItemType.product && item.productId) {
        await this.adjustProductItemStock(
          item,
          uid,
          user._id,
          createdByType,
          TransactionType.CONSUME,
          session,
        );
      }
    }
  }

  private async returnInventory(
    items: OrderItem[],
    uid: string,
    user: User,
    session?: ClientSession,
  ): Promise<void> {
    const createdByType = this.getRole(user)?.roleId ?? 'unknown';
    for (const item of items) {
      if (item.type === OrderItemType.service && item.defaultProducts?.length) {
        for (const dp of item.defaultProducts) {
          if (!dp.included) continue;
          const multiplier =
            dp.per && dp.per !== DefaultProductPer.order ? item.quantity : 1;
          await this.adjustServiceItemStock(
            dp,
            uid,
            user._id,
            createdByType,
            TransactionType.RETURN,
            dp.quantity * multiplier,
            session,
          );
        }
      }
      if (item.type === OrderItemType.product && item.productId) {
        await this.adjustProductItemStock(
          item,
          uid,
          user._id,
          createdByType,
          TransactionType.RETURN,
          session,
        );
      }
    }
  }

  private async validateBranchForOrder(
    branchId: string,
    uid: string,
    user: User,
    activeBranchId?: string | null,
  ): Promise<void> {
    const branch = await this.branchModel.findById(branchId).exec();
    if (!branch || branch.uid !== uid)
      throw new BadRequestException(
        'Branch not found or does not belong to you',
      );
    if (!branch.isActive) throw new BadRequestException('Branch is inactive');
    const role = this.getRole(user);
    if (role?.roleId === 'staff') {
      // Assignment alone is no longer enough. A staff member's permissions are
      // granted per branch and checked against the branch their device is
      // pinned to, so writing to a DIFFERENT assigned branch would be authorized
      // by grants that do not apply there. They may only write where they are
      // working.
      if (activeBranchId) {
        if (String(activeBranchId) !== branch._id.toString()) {
          throw new BadRequestException(
            'You can only create orders for the branch this device is assigned to',
          );
        }
        return;
      }
      const staffBranchIds = (user.branchIds as unknown as string[]) ?? [];
      if (
        !staffBranchIds.some((id) => id.toString() === branch._id.toString())
      ) {
        throw new BadRequestException('You are not assigned to this branch');
      }
    }
  }

  private async resolveServiceItem(
    item: OrderItemInput,
    uid: string,
    session?: ClientSession,
  ): Promise<{ resolved: OrderItem; subtotal: number }> {
    if (!item.serviceId)
      throw new BadRequestException(
        'Please select a valid service for each service item.',
      );
    const service = await this.serviceModel
      .findOne({ _id: new Types.ObjectId(item.serviceId), uid } as any)
      .session(session ?? null)
      .exec();
    if (!service)
      throw new BadRequestException(
        'One or more selected services could not be found.',
      );
    if (service.isArchived)
      throw new BadRequestException(
        `"${service.serviceName}" has been archived and is no longer available.`,
      );
    const subtotal = this.calculateItemSubtotal(item, service);
    return {
      resolved: {
        type: item.type,
        serviceId: item.serviceId,
        serviceName: service.serviceName,
        serviceCode: service.serviceCode,
        pricingType: service.pricingType,
        defaultProducts:
          item.defaultProducts ??
          service.defaultProducts?.map((dp) => ({ ...dp, included: true })) ??
          [],
        quantity: item.quantity,
        unitPrice: service.price,
        subtotal,
      },
      subtotal,
    };
  }

  private resolveCustomItem(item: OrderItemInput): {
    resolved: OrderItem;
    subtotal: number;
  } {
    if (!item.serviceName?.trim())
      throw new BadRequestException(
        'Custom items require a name (e.g. "Delivery Fee").',
      );
    if (item.unitPrice == null)
      throw new BadRequestException('Custom items require a unit price.');
    const subtotal = item.quantity * item.unitPrice;
    return {
      resolved: {
        type: OrderItemType.custom,
        serviceId: item.serviceId,
        serviceName: item.serviceName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        subtotal,
      },
      subtotal,
    };
  }

  private async resolveProductItem(
    item: OrderItemInput,
    uid: string,
    session?: ClientSession,
  ): Promise<{ resolved: OrderItem; subtotal: number }> {
    if (!item.productId)
      throw new BadRequestException(
        'Please select a valid product for each product item.',
      );
    // Product has no uid of its own — ownership is enforced below via the
    // linked Inventory item, which is the only place uid is actually stored.
    const product = await this.productModel
      .findById(item.productId)
      .session(session ?? null)
      .exec();
    if (!product)
      throw new BadRequestException(
        'One or more selected products could not be found.',
      );
    if (product.isArchived)
      throw new BadRequestException(
        `"${product.productName}" has been archived and is no longer available.`,
      );
    const productInventory = await this.inventoryModel
      .findOne({ _id: product.inventoryId, uid } as any)
      .session(session ?? null)
      .exec();
    if (!productInventory)
      throw new BadRequestException(
        'One or more selected products are not available.',
      );
    if (productInventory.isArchived)
      throw new BadRequestException(
        `"${product.productName}" is no longer available.`,
      );
    const subtotal = item.quantity * product.price;
    return {
      resolved: {
        type: item.type,
        productId: item.productId,
        productName: product.productName,
        quantity: item.quantity,
        unitPrice: product.price,
        subtotal,
      },
      subtotal,
    };
  }

  private async resolveOrderItems(
    items: OrderItemInput[],
    uid: string,
    session?: ClientSession,
  ): Promise<{ resolvedItems: OrderItem[]; subtotal: number }> {
    const resolvedItems: OrderItem[] = [];
    let subtotal = 0;
    for (const item of items) {
      const { resolved, subtotal: itemSubtotal } =
        item.type === OrderItemType.custom
          ? this.resolveCustomItem(item)
          : item.type === OrderItemType.service
            ? await this.resolveServiceItem(item, uid, session)
            : await this.resolveProductItem(item, uid, session);
      resolvedItems.push(resolved);
      subtotal += itemSubtotal;
    }
    return { resolvedItems, subtotal };
  }

  async create(
    input: CreateOrderInput,
    user: User,
    activeBranchId?: string | null,
  ): Promise<PosOrder> {
    const uid = this.getMerchantId(user);
    const role = this.getRole(user);

    if (input.idempotencyKey) {
      const existing = await this.orderModel
        .findOne({ uid, idempotencyKey: input.idempotencyKey })
        .exec();
      if (existing) return existing;
    }

    await this.validateBranchForOrder(
      input.branchId,
      uid,
      user,
      activeBranchId,
    );

    if (input.discountType && role?.roleId === 'staff') {
      // Checked against the branch the order is FOR, not merely "somewhere".
      // This used to scan the account-global permissionIds union, which under
      // per-branch grants would let a discount right held in one branch price
      // down another branch's order.
      const hasDiscount = await holdsOnBranch(
        this.permissionModel,
        user,
        input.branchId,
        ['order_apply_discount'],
      );
      if (!hasDiscount)
        throw new ForbiddenException(
          'You do not have permission to apply discounts',
        );
    }

    const session = await this.connection.startSession();
    let saved: PosOrderDocument;
    try {
      await session.withTransaction(async () => {
        const { resolvedItems, subtotal } = await this.resolveOrderItems(
          input.items,
          uid,
          session,
        );

        const discount = this.calculateDiscount(
          subtotal,
          input.discountType,
          input.discountValue,
        );
        const totalAmount = subtotal - discount;
        const claimCode = await this.getUniqueClaimCode();
        const hasService = resolvedItems.some(
          (i) => i.type === OrderItemType.service,
        );

        const order = new this.orderModel({
          uid,
          branchId: input.branchId,
          createdBy: user._id,
          createdByType: role?.roleId ?? 'unknown',
          customerName: input.customerName,
          customerPhone: input.customerPhone,
          customerAddress: input.customerAddress,
          notes: input.notes,
          items: resolvedItems,
          subtotal,
          discountType: input.discountType ?? null,
          discountValue: input.discountValue ?? null,
          discount,
          totalAmount,
          claimCode,
          estimatedReadyAt: hasService
            ? (input.estimatedReadyAt ?? null)
            : null,
          fulfillmentType: input.fulfillmentType ?? FulfillmentType.PICKUP,
          paymentStatus: PaymentStatus.UNPAID,
          laundryStatus: LaundryStatus.PENDING,
          idempotencyKey: input.idempotencyKey ?? null,
        });
        saved = await order.save({ session });
        // Deduct inventory at order creation time to reserve stock immediately,
        // preventing overselling when multiple orders are created before payment.
        // Runs in the same transaction as the order save — if stock is
        // insufficient for any line, the whole order creation rolls back.
        await this.deductInventory(resolvedItems, uid, user, session);
      });
    } finally {
      await session.endSession();
    }
    this.logger.log(
      `Order created: ${saved!.claimCode} | branch=${input.branchId} | total=${saved!.totalAmount} | by=${user._id}`,
    );
    return saved!;
  }

  async findAll(
    uid: string,
    allowedBranchIds: string[] | null,
    filter: OrderFilterInput = {},
  ): Promise<PaginatedOrders> {
    const {
      branchId,
      search,
      laundryStatus,
      paymentStatus,
      dateFrom,
      dateTo,
      limit = 10,
      offset = 0,
    } = filter;
    const safeLimit = Math.min(limit ?? 10, 100);
    const query: Record<string, any> = { uid };
    applyBranchScope(query, { merchantId: uid, allowedBranchIds }, branchId);
    if (search)
      query.customerName = {
        $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        $options: 'i',
      };
    if (laundryStatus) query.laundryStatus = laundryStatus;
    if (paymentStatus) query.paymentStatus = paymentStatus;
    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = dateFrom;
      if (dateTo) query.createdAt.$lte = dateTo;
    }
    const [data, total] = await Promise.all([
      this.orderModel
        .find(query)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(safeLimit)
        .exec(),
      this.orderModel.countDocuments(query).exec(),
    ]);
    return { data, total, limit: safeLimit, offset };
  }

  async orderHistory(
    uid: string,
    allowedBranchIds: string[] | null,
    filter: OrderFilterInput = {},
  ): Promise<PaginatedOrders> {
    return this.findAll(uid, allowedBranchIds, {
      ...filter,
      laundryStatus: LaundryStatus.CLAIMED,
    });
  }

  async findById(id: string, uid: string): Promise<PosOrder> {
    const order = await this.orderModel.findOne({ _id: id, uid } as any).exec();
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async findByClaimCode(claimCode: string, uid: string): Promise<PosOrder> {
    const order = await this.orderModel
      .findOne({ claimCode: claimCode.toUpperCase(), uid })
      .exec();
    if (!order)
      throw new NotFoundException(
        `No order found with claim code "${claimCode}"`,
      );
    return order;
  }

  async updateDetails(
    id: string,
    uid: string,
    input: {
      customerName?: string;
      customerPhone?: string;
      customerAddress?: string;
      notes?: string;
      estimatedReadyAt?: Date;
    },
  ): Promise<PosOrder> {
    const order = await this.orderModel.findById(id).exec();
    if (!order || order.uid !== uid)
      throw new NotFoundException('Order not found');
    if (
      [
        LaundryStatus.COMPLETED,
        LaundryStatus.CLAIMED,
        LaundryStatus.CANCELLED,
        LaundryStatus.VOID,
      ].includes(order.laundryStatus)
    ) {
      throw new BadRequestException(
        'Cannot edit a completed, cancelled, or voided order',
      );
    }
    const updated = await this.orderModel
      .findOneAndUpdate({ _id: id, uid } as any, { $set: input }, { new: true })
      .exec();
    return updated as any;
  }

  async markInProgress(id: string, uid: string): Promise<PosOrder> {
    const order = await this.orderModel.findById(id).exec();
    if (!order || order.uid !== uid)
      throw new NotFoundException('Order not found');
    if (order.laundryStatus !== LaundryStatus.PENDING)
      throw new BadRequestException(
        'Order must be pending to mark in progress',
      );
    return this.orderModel
      .findOneAndUpdate(
        { _id: id, uid } as any,
        { $set: { laundryStatus: LaundryStatus.IN_PROGRESS } },
        { new: true },
      )
      .exec() as any;
  }

  async markReady(id: string, uid: string): Promise<PosOrder> {
    const order = await this.orderModel.findById(id).exec();
    if (!order || order.uid !== uid)
      throw new NotFoundException('Order not found');
    if (order.laundryStatus !== LaundryStatus.IN_PROGRESS)
      throw new BadRequestException('Order must be in progress to mark ready');
    return this.orderModel
      .findOneAndUpdate(
        { _id: id, uid } as any,
        { $set: { laundryStatus: LaundryStatus.READY } },
        { new: true },
      )
      .exec() as any;
  }

  async reschedule(
    id: string,
    uid: string,
    newEstimatedReadyAt: Date,
    reason?: string,
  ): Promise<PosOrder> {
    const order = await this.orderModel.findById(id).exec();
    if (!order || order.uid !== uid)
      throw new NotFoundException('Order not found');
    if (
      ![LaundryStatus.PENDING, LaundryStatus.IN_PROGRESS].includes(
        order.laundryStatus,
      )
    ) {
      throw new BadRequestException(
        'Can only reschedule pending or in-progress orders',
      );
    }
    const update: any = { estimatedReadyAt: newEstimatedReadyAt };
    if (reason)
      update.notes = order.notes
        ? `${order.notes} | Reschedule: ${reason}`
        : `Reschedule: ${reason}`;
    return this.orderModel
      .findOneAndUpdate(
        { _id: id, uid } as any,
        { $set: update },
        { new: true },
      )
      .exec() as any;
  }

  async processPayment(
    id: string,
    uid: string,
    input: ProcessPaymentInput,
    user: User,
  ): Promise<PosOrder> {
    // Atomic guard: only one concurrent call can win by transitioning UNPAID -> PAID in a single findOneAndUpdate.
    // Any subsequent concurrent call will find paymentStatus !== UNPAID and won't match, preventing double-processing.
    const orderToLock = await this.orderModel
      .findOneAndUpdate(
        { _id: id, uid, paymentStatus: PaymentStatus.UNPAID } as any,
        { $set: { paymentStatus: PaymentStatus.PAID } },
        { new: false }, // return the pre-update doc so we still have totalAmount etc.
      )
      .exec();

    if (!orderToLock) {
      // Order either doesn't exist, doesn't belong to this merchant, or is already PAID/REFUNDED
      const existing = await this.orderModel
        .findOne({ _id: id, uid } as any)
        .exec();
      if (!existing) throw new NotFoundException('Order not found');
      if (existing.paymentStatus === PaymentStatus.PAID)
        throw new BadRequestException('Order is already paid');
      throw new BadRequestException('Order payment cannot be processed');
    }

    const order = orderToLock; // use the pre-lock document for remaining logic

    if (
      [LaundryStatus.CANCELLED, LaundryStatus.VOID].includes(
        order.laundryStatus,
      )
    ) {
      // Roll back the status change we just made before throwing
      await this.orderModel
        .findOneAndUpdate({ _id: id, uid } as any, {
          $set: { paymentStatus: PaymentStatus.UNPAID },
        })
        .exec();
      throw new BadRequestException(
        'Cannot process payment on a cancelled or voided order',
      );
    }
    const isNonCash = [
      'gcash',
      'maya',
      'qph',
      'card',
      'bank_transfer',
    ].includes(input.paymentMethod);
    if (isNonCash && !input.referenceId) {
      await this.orderModel
        .findOneAndUpdate({ _id: id, uid } as any, {
          $set: { paymentStatus: PaymentStatus.UNPAID },
        })
        .exec();
      throw new BadRequestException(
        'A reference number is required for non-cash payments.',
      );
    }
    if (input.amountPaid < order.totalAmount) {
      await this.orderModel
        .findOneAndUpdate({ _id: id, uid } as any, {
          $set: { paymentStatus: PaymentStatus.UNPAID },
        })
        .exec();
      throw new BadRequestException('Amount paid is less than total amount');
    }
    const change = input.amountPaid - order.totalAmount;
    const role = this.getRole(user);
    const txDoc: Partial<Omit<PosTransaction, '_id'>> = {
      orderId: id,
      paymentMethod: input.paymentMethod,
      referenceId: input.referenceId ?? undefined,
      totalAmount: order.totalAmount,
      amountPaid: input.amountPaid,
      change,
      status: TransactionStatus.COMPLETED,
      processedBy: user._id,
      processedByType: role?.roleId ?? 'unknown',
    };
    await this.txModel.create(txDoc);

    // A product-only sale (no service items) has nothing to "process" — the
    // customer already has the item in hand once paid. Skip the laundry
    // queue entirely instead of requiring a cashier to manually advance
    // Processing -> Ready -> Claimed for something already handed over.
    // Guarded on PENDING so this never overrides a mixed order that's
    // already been advanced (e.g. IN_PROGRESS) before payment was captured.
    const hasService = (order.items ?? []).some(
      (i: OrderItem) => i.type === OrderItemType.service,
    );
    const statusUpdate: Record<string, unknown> =
      !hasService && order.laundryStatus === LaundryStatus.PENDING
        ? { laundryStatus: LaundryStatus.COMPLETED }
        : {};

    // paymentStatus was already set to PAID atomically in the guard above.
    const updated = await this.orderModel
      .findOneAndUpdate(
        { _id: id, uid } as any,
        { $set: statusUpdate },
        { new: true },
      )
      .exec();
    this.logger.log(
      `Payment processed: order=${order.claimCode} | method=${input.paymentMethod} | paid=${input.amountPaid} | change=${change} | by=${user._id}`,
    );
    return updated as any;
  }

  async processPickup(id: string, uid: string, user: User): Promise<PosOrder> {
    const order = await this.orderModel.findById(id).exec();
    if (!order || order.uid !== uid)
      throw new NotFoundException('Order not found');
    if (order.laundryStatus !== LaundryStatus.READY)
      throw new BadRequestException('Order must be ready for pickup');
    if (order.paymentStatus !== PaymentStatus.PAID)
      throw new BadRequestException('Order must be paid before pickup');
    const updated = await this.orderModel
      .findOneAndUpdate(
        { _id: id, uid } as any,
        {
          $set: {
            laundryStatus: LaundryStatus.CLAIMED,
            claimedBy: user._id,
            claimedAt: new Date(),
          },
        },
        { new: true },
      )
      .exec();
    return updated as any;
  }

  async cancelOrder(
    id: string,
    uid: string,
    user: User,
    reason?: string,
    restoreInventory?: boolean,
  ): Promise<PosOrder> {
    const order = await this.orderModel.findById(id).exec();
    if (!order || order.uid !== uid)
      throw new NotFoundException('Order not found');
    if (
      ![LaundryStatus.PENDING, LaundryStatus.IN_PROGRESS].includes(
        order.laundryStatus,
      )
    ) {
      throw new BadRequestException(
        'Only pending or in-progress orders can be cancelled',
      );
    }
    if (order.paymentStatus === PaymentStatus.PAID)
      throw new BadRequestException(
        'Order is already paid. Use voidOrder instead',
      );
    const update: any = { laundryStatus: LaundryStatus.CANCELLED };
    if (reason)
      update.notes = order.notes
        ? `${order.notes} | Cancelled: ${reason}`
        : `Cancelled: ${reason}`;
    const session = await this.connection.startSession();
    let updated: PosOrderDocument | null;
    try {
      await session.withTransaction(async () => {
        // Return inventory that was deducted at order creation time, unless
        // the caller confirms the service was already carried out (e.g.
        // detergent already used mid-wash) and stock should stay deducted.
        if (restoreInventory ?? true) {
          await this.returnInventory(order.items, uid, user, session);
        }
        updated = await this.orderModel
          .findOneAndUpdate(
            { _id: id, uid } as any,
            { $set: update },
            { new: true, session },
          )
          .exec();
      });
    } finally {
      await session.endSession();
    }
    this.logger.warn(
      `Order cancelled: ${order.claimCode} | reason=${reason ?? 'none'} | by=${uid}`,
    );
    return updated! as any;
  }

  async voidOrder(
    id: string,
    uid: string,
    user: User,
    reason?: string,
    restoreInventory?: boolean,
  ): Promise<PosOrder> {
    const order = await this.orderModel.findById(id).exec();
    if (!order || order.uid !== uid)
      throw new NotFoundException('Order not found');
    if (order.laundryStatus === LaundryStatus.VOID)
      throw new BadRequestException('Order is already voided');
    if (order.laundryStatus === LaundryStatus.CANCELLED)
      throw new BadRequestException('Cannot void a cancelled order');
    const role = this.getRole(user);
    // Whether to put deducted stock back is a fulfillment question, not a
    // payment question: a paid order can already be COMPLETED or CLAIMED
    // (goods handed over — stock stays deducted) and an unpaid order can
    // still have had consumables used mid-service. Default to the order's
    // own status when the caller doesn't say explicitly.
    const shouldRestore =
      restoreInventory ??
      ![LaundryStatus.COMPLETED, LaundryStatus.CLAIMED].includes(
        order.laundryStatus,
      );
    const update: any = {
      laundryStatus: LaundryStatus.VOID,
      paymentStatus:
        order.paymentStatus === PaymentStatus.PAID
          ? PaymentStatus.REFUNDED
          : PaymentStatus.UNPAID,
    };
    if (reason)
      update.notes = order.notes
        ? `${order.notes} | Voided: ${reason}`
        : `Voided: ${reason}`;
    const session = await this.connection.startSession();
    let updated: PosOrderDocument | null;
    try {
      await session.withTransaction(async () => {
        if (order.paymentStatus === PaymentStatus.PAID) {
          const originalTx = await this.txModel
            .findOne({ orderId: id, status: TransactionStatus.COMPLETED })
            .session(session)
            .exec();
          // Refunds must never be blocked by a missing original transaction:
          // POS is walk-in trade, so the customer is standing at the counter.
          // `paymentMethod` is nullable on PosTransaction for exactly this case
          // (see the schema comment). Previously this wrote the literal
          // 'unknown', which is not a PaymentMethod member — Mongoose rejected
          // the document and, inside withTransaction, aborted the whole refund.
          const txDoc: Partial<Omit<PosTransaction, '_id'>> = {
            orderId: id,
            paymentMethod: originalTx?.paymentMethod ?? null,
            totalAmount: order.totalAmount,
            amountPaid: order.totalAmount,
            change: 0,
            status: TransactionStatus.REFUNDED,
            processedBy: user._id,
            processedByType: role?.roleId ?? 'unknown',
          };
          await this.txModel.create([txDoc], { session });
        }
        if (shouldRestore) {
          await this.returnInventory(order.items, uid, user, session);
        }
        updated = await this.orderModel
          .findOneAndUpdate(
            { _id: id, uid } as any,
            { $set: update },
            { new: true, session },
          )
          .exec();
      });
    } finally {
      await session.endSession();
    }
    this.logger.warn(
      `Order voided: ${order.claimCode} | wasPaid=${order.paymentStatus === PaymentStatus.PAID} | restoredInventory=${shouldRestore} | reason=${reason ?? 'none'} | by=${user._id}`,
    );
    return updated! as any;
  }

  async addOrderItems(
    id: string,
    uid: string,
    items: OrderItemInput[],
    paymentInput: ProcessPaymentInput,
    user: User,
  ): Promise<PosOrder> {
    const order = await this.orderModel.findById(id).exec();
    if (!order || order.uid !== uid)
      throw new NotFoundException('Order not found');
    if (order.paymentStatus !== PaymentStatus.PAID)
      throw new BadRequestException('Add-ons are only allowed on paid orders');
    if (
      [
        LaundryStatus.CLAIMED,
        LaundryStatus.CANCELLED,
        LaundryStatus.VOID,
      ].includes(order.laundryStatus)
    ) {
      throw new BadRequestException(
        'Cannot add items to a cancelled or voided order',
      );
    }
    for (const item of items) {
      if (item.type !== OrderItemType.product || !item.productId) {
        throw new BadRequestException('Add-ons must be product items only');
      }
    }
    if (paymentInput.amountPaid <= 0)
      throw new BadRequestException('Amount paid must be greater than 0');

    const session = await this.connection.startSession();
    let updated: PosOrderDocument | null;
    try {
      await session.withTransaction(async () => {
        const newItems: OrderItem[] = [];
        let addOnSubtotal = 0;
        for (const item of items) {
          const { resolved, subtotal: itemSubtotal } =
            await this.resolveProductItem(item, uid, session);
          newItems.push(resolved);
          addOnSubtotal += itemSubtotal;
        }
        if (paymentInput.amountPaid < addOnSubtotal)
          throw new BadRequestException(
            'Amount paid is less than add-on total',
          );
        const role = this.getRole(user);
        const txDoc: Partial<Omit<PosTransaction, '_id'>> = {
          orderId: id,
          paymentMethod: paymentInput.paymentMethod,
          referenceId: paymentInput.referenceId ?? undefined,
          totalAmount: addOnSubtotal,
          amountPaid: paymentInput.amountPaid,
          change: paymentInput.amountPaid - addOnSubtotal,
          status: TransactionStatus.ADD_ON,
          processedBy: user._id,
          processedByType: role?.roleId ?? 'unknown',
        };
        await this.txModel.create([txDoc], { session });
        await this.deductInventory(newItems, uid, user, session);
        const newSubtotal = order.subtotal + addOnSubtotal;
        const newTotal = newSubtotal - order.discount;
        updated = await this.orderModel
          .findOneAndUpdate(
            { _id: id, uid } as any,
            {
              $push: { items: { $each: newItems } },
              $set: { subtotal: newSubtotal, totalAmount: newTotal },
            },
            { new: true, session },
          )
          .exec();
      });
    } finally {
      await session.endSession();
    }
    return updated! as any;
  }

  async getTransactions(
    orderId: string,
    uid: string,
  ): Promise<PosTransaction[]> {
    const ownerCheck = await this.orderModel
      .findOne({ _id: orderId, uid } as any)
      .exec();
    if (!ownerCheck) throw new NotFoundException('Order not found');
    const txFilter: any = { orderId };
    return this.txModel.find(txFilter).sort({ createdAt: 1 }).exec();
  }

  async getMyTransactions(
    uid: string,
    allowedBranchIds: string[] | null,
    filter: { branchId?: string; dateFrom?: Date; dateTo?: Date } = {},
  ): Promise<PosTransaction[]> {
    const orderQuery: Record<string, any> = { uid };
    applyBranchScope(
      orderQuery,
      { merchantId: uid, allowedBranchIds },
      filter.branchId,
    );
    if (filter.dateFrom || filter.dateTo) {
      const dateFilter: { $gte?: Date; $lte?: Date } = {};
      if (filter.dateFrom) dateFilter.$gte = filter.dateFrom;
      if (filter.dateTo) dateFilter.$lte = filter.dateTo;
      orderQuery.createdAt = dateFilter;
    }
    const orders = await this.orderModel
      .find(orderQuery)
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    if (!orders.length) return [];
    const orderIds = orders.map((o) => o._id.toString());
    return this.txModel
      .find({ orderId: { $in: orderIds } })
      .sort({ createdAt: -1 })
      .exec();
  }

  async getReceipt(id: string, uid: string): Promise<Receipt> {
    const order = await this.orderModel.findOne({ _id: id, uid } as any).exec();
    if (!order) throw new NotFoundException('Order not found');
    const branch = await this.branchModel.findById(order.branchId).exec();
    if (!branch) throw new NotFoundException('Branch not found');
    const txFilter: any = { orderId: id };
    const transactions = await this.txModel
      .find(txFilter)
      .sort({ createdAt: 1 })
      .exec();
    return {
      orderId: order._id.toString(),
      claimCode: order.claimCode,
      customerName: order.customerName,
      processedBy: order.createdBy,
      createdAt: order.createdAt!,
      branch: {
        branchName: branch.branchName,
        branchPhoneNumber: branch.branchPhoneNumber,
        regionName: branch.branchAddress.regionName,
        cityMunicipalityName: branch.branchAddress.cityMunicipalityName,
        streetAddress: branch.branchAddress.streetAddress,
      },
      items: order.items,
      subtotal: order.subtotal,
      discountType: order.discountType,
      discountValue: order.discountValue,
      discount: order.discount,
      totalAmount: order.totalAmount,
      transactions,
    };
  }
}
