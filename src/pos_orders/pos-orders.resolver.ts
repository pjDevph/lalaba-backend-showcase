import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  ResolveField,
  Parent,
} from '@nestjs/graphql';
import { Logger, UseGuards } from '@nestjs/common';
import { PosOrdersService } from './pos-orders.service';
import { PosOrder } from './schemas/pos-order.schema';
import { PosTransaction } from '../pos_transactions/schemas/pos-transaction.schema';
import { CreateOrderInput, OrderItemInput } from './dto/create-order.input';
import { ProcessPaymentInput } from './dto/process-payment.input';
import { OrderFilterInput } from './dto/order-filter.input';
import { PaginatedOrders } from './models/paginated-orders.model';
import { Receipt } from './models/receipt.model';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ActiveBranch } from '../auth/decorators/active-branch.decorator';
import type { Types } from 'mongoose';
import { User } from '../users/schemas/user.schema';
import { TransactionsLoader } from './transactions.loader';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';

// SEC-026..030 — role floor for the whole resolver.
//
// Everything here is merchant-side: a POS terminal, a stock room, a service
// catalogue, a branch task list. The queries used to be reachable by ANY
// authenticated account — a customer or a courier could call them. Nothing
// leaked, because each one derives merchantId from the caller and a customer
// simply matched nothing, but that made the tenancy scoping the only thing
// standing between these and a real breach. One query that takes an id from
// its arguments instead of the session would have been enough.
//
// Note RolesGuard returns true when no @Roles metadata is present, so the
// absence of this line was silent — nothing failed, nothing warned.
@Resolver(() => PosOrder)
@Roles('merchant', 'staff')
@UseGuards(GqlAuthGuard, RolesGuard)
export class PosOrdersResolver {
  private readonly logger = new Logger(PosOrdersResolver.name);

  constructor(
    private readonly posOrdersService: PosOrdersService,
    private readonly transactionsLoader: TransactionsLoader,
  ) {}

  @RequirePermissions('order_create')
  @UseGuards(PermissionsGuard)
  @Mutation(() => PosOrder)
  async createOrder(
    @Args('input') input: CreateOrderInput,
    @CurrentUser() user: User,
    @ActiveBranch() activeBranchId: string | null,
  ) {
    this.logger.debug(
      `createOrder | user=${user._id} | branch=${input.branchId} | items=${JSON.stringify(input.items)}`,
    );
    return this.posOrdersService.create(input, user, activeBranchId);
  }

  @Query(() => PaginatedOrders, { name: 'myOrders' })
  async getMyOrders(
    @Args('filter', { type: () => OrderFilterInput, nullable: true })
    filter: OrderFilterInput,
    @CurrentUser() user: User,
    @ActiveBranch() activeBranchId: string | null,
  ) {
    return this.posOrdersService.findAll(
      this.posOrdersService.getMerchantId(user),
      this.posOrdersService.getBranchIds(user, activeBranchId),
      filter,
    );
  }

  @Query(() => PaginatedOrders, { name: 'orderHistory' })
  async getOrderHistory(
    @Args('filter', { type: () => OrderFilterInput, nullable: true })
    filter: OrderFilterInput,
    @CurrentUser() user: User,
    @ActiveBranch() activeBranchId: string | null,
  ) {
    return this.posOrdersService.orderHistory(
      this.posOrdersService.getMerchantId(user),
      this.posOrdersService.getBranchIds(user, activeBranchId),
      filter,
    );
  }

  @Query(() => PosOrder, { name: 'getOrder' })
  async getOrder(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ) {
    return this.posOrdersService.findById(
      id,
      this.posOrdersService.getMerchantId(user),
    );
  }

  @Query(() => PosOrder, { name: 'getOrderByClaimCode' })
  async getOrderByClaimCode(
    @Args('claimCode') claimCode: string,
    @CurrentUser() user: User,
  ) {
    return this.posOrdersService.findByClaimCode(
      claimCode,
      this.posOrdersService.getMerchantId(user),
    );
  }

  @Query(() => [PosTransaction], { name: 'orderTransactions' })
  async getOrderTransactions(
    @Args('orderId', { type: () => ID }) orderId: string,
    @CurrentUser() user: User,
  ) {
    return this.posOrdersService.getTransactions(
      orderId,
      this.posOrdersService.getMerchantId(user),
    );
  }

  @Query(() => [PosTransaction], { name: 'myTransactions' })
  async getMyTransactions(
    @Args('filter', { type: () => OrderFilterInput, nullable: true })
    filter: OrderFilterInput,
    @CurrentUser() user: User,
    @ActiveBranch() activeBranchId: string | null,
  ) {
    return this.posOrdersService.getMyTransactions(
      this.posOrdersService.getMerchantId(user),
      this.posOrdersService.getBranchIds(user, activeBranchId),
      filter ?? {},
    );
  }

  @Query(() => Receipt, { name: 'getReceipt' })
  async getReceipt(
    @Args('orderId', { type: () => ID }) orderId: string,
    @CurrentUser() user: User,
  ) {
    return this.posOrdersService.getReceipt(
      orderId,
      this.posOrdersService.getMerchantId(user),
    );
  }

  @ResolveField(() => [PosTransaction])
  transactions(
    @Parent() order: PosOrder & { _id: Types.ObjectId },
  ): Promise<PosTransaction[]> {
    return this.transactionsLoader.load(order._id.toString());
  }

  @RequirePermissions('order_update_status')
  @UseGuards(PermissionsGuard)
  @Mutation(() => PosOrder)
  async updateOrderDetails(
    @Args('id', { type: () => ID }) id: string,
    @Args('customerName', { nullable: true }) customerName?: string,
    @Args('customerPhone', { nullable: true }) customerPhone?: string,
    @Args('customerAddress', { nullable: true }) customerAddress?: string,
    @Args('notes', { nullable: true }) notes?: string,
    @Args('estimatedReadyAt', { nullable: true }) estimatedReadyAt?: Date,
    @CurrentUser() user?: User,
  ) {
    return this.posOrdersService.updateDetails(
      id,
      this.posOrdersService.getMerchantId(user!),
      { customerName, customerPhone, customerAddress, notes, estimatedReadyAt },
    );
  }

  @RequirePermissions('order_update_status')
  @UseGuards(PermissionsGuard)
  @Mutation(() => PosOrder)
  async markOrderInProgress(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ) {
    return this.posOrdersService.markInProgress(
      id,
      this.posOrdersService.getMerchantId(user),
    );
  }

  @RequirePermissions('order_update_status')
  @UseGuards(PermissionsGuard)
  @Mutation(() => PosOrder)
  async markOrderReady(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ) {
    return this.posOrdersService.markReady(
      id,
      this.posOrdersService.getMerchantId(user),
    );
  }

  @RequirePermissions('order_update_status')
  @UseGuards(PermissionsGuard)
  @Mutation(() => PosOrder)
  async rescheduleOrder(
    @Args('id', { type: () => ID }) id: string,
    @Args('newEstimatedReadyAt') newEstimatedReadyAt: Date,
    @Args('reason', { nullable: true }) reason: string,
    @CurrentUser() user: User,
  ) {
    return this.posOrdersService.reschedule(
      id,
      this.posOrdersService.getMerchantId(user),
      newEstimatedReadyAt,
      reason,
    );
  }

  // Payment is taken in two flows: when ringing up a new sale at the terminal
  // (part of `order_create`) and when settling at pickup (`order_confirm_pickup`).
  // The guard uses OR semantics, so either permission authorizes it — a staff
  // granted only "Create orders" can complete a pay-now sale end to end.
  @RequirePermissions('order_create', 'order_confirm_pickup')
  @UseGuards(PermissionsGuard)
  @Mutation(() => PosOrder)
  async processPayment(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: ProcessPaymentInput,
    @CurrentUser() user: User,
  ) {
    return this.posOrdersService.processPayment(
      id,
      this.posOrdersService.getMerchantId(user),
      input,
      user,
    );
  }

  @RequirePermissions('order_confirm_pickup')
  @UseGuards(PermissionsGuard)
  @Mutation(() => PosOrder)
  async processPickup(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ) {
    return this.posOrdersService.processPickup(
      id,
      this.posOrdersService.getMerchantId(user),
      user,
    );
  }

  @RequirePermissions('order_cancel')
  @UseGuards(PermissionsGuard)
  @Mutation(() => PosOrder)
  async cancelOrder(
    @Args('id', { type: () => ID }) id: string,
    @Args('reason', { nullable: true }) reason: string,
    @Args('restoreInventory', { type: () => Boolean, nullable: true })
    restoreInventory: boolean,
    @CurrentUser() user: User,
  ) {
    return this.posOrdersService.cancelOrder(
      id,
      this.posOrdersService.getMerchantId(user),
      user,
      reason,
      restoreInventory,
    );
  }

  @RequirePermissions('order_cancel')
  @UseGuards(PermissionsGuard)
  @Mutation(() => PosOrder)
  async voidOrder(
    @Args('id', { type: () => ID }) id: string,
    @Args('reason', { nullable: true }) reason: string,
    @Args('restoreInventory', { type: () => Boolean, nullable: true })
    restoreInventory: boolean,
    @CurrentUser() user: User,
  ) {
    return this.posOrdersService.voidOrder(
      id,
      this.posOrdersService.getMerchantId(user),
      user,
      reason,
      restoreInventory,
    );
  }

  @RequirePermissions('order_update_status')
  @UseGuards(PermissionsGuard)
  @Mutation(() => PosOrder)
  async addOrderItems(
    @Args('id', { type: () => ID }) id: string,
    @Args('items', { type: () => [OrderItemInput] }) items: OrderItemInput[],
    @Args('payment') payment: ProcessPaymentInput,
    @CurrentUser() user: User,
  ) {
    return this.posOrdersService.addOrderItems(
      id,
      this.posOrdersService.getMerchantId(user),
      items,
      payment,
      user,
    );
  }
}
