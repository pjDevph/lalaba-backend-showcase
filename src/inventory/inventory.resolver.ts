import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { Inventory } from './schemas/inventory.schema';
import { InventoryTransaction } from './schemas/inventory-transaction.schema';
import { CreateInventoryInput } from './dto/create-inventory.input';
import { UpdateInventoryInput } from './dto/update-inventory.input';
import { RestockInventoryInput } from './dto/restock-inventory.input';
import { AdjustInventoryInput } from './dto/adjust-inventory.input';
import { DamageInventoryInput } from './dto/damage-inventory.input';
import { InventoryFilterInput } from './dto/inventory-filter.input';
import { TransactionFilterInput } from './dto/transaction-filter.input';
import { PaginatedInventory } from './models/paginated-inventory.model';
import { PaginatedTransactions } from './models/paginated-transactions.model';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ActiveBranch } from '../auth/decorators/active-branch.decorator';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';
import {
  applyBranchScope,
  resolveTenantScope,
} from '../common/scoping/tenant-scope';
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
@Resolver(() => Inventory)
@Roles('merchant', 'staff')
@UseGuards(GqlAuthGuard, RolesGuard)
export class InventoryResolver {
  constructor(private readonly inventoryService: InventoryService) {}

  private getMerchantId(user: User): string {
    const role = user.role as unknown as Role;
    return role?.roleId === 'staff' ? user.merchantId! : user._id;
  }

  private getBranchIds(
    user: User,
    activeBranchId?: string | null,
  ): string[] | null {
    // SEC-016/M6 — delegates to the canonical resolver. `null` means an owner,
    // who is not branch restricted; `[]` means staff with no assignment, who
    // must see nothing. The two were indistinguishable before.
    return resolveTenantScope(user, activeBranchId).allowedBranchIds;
  }

  @RequirePermissions('inventory_create')
  @UseGuards(PermissionsGuard)
  @Mutation(() => Inventory)
  async createInventory(
    @Args('input') input: CreateInventoryInput,
    @CurrentUser() user: User,
  ) {
    return this.inventoryService.create(input, user);
  }

  @Query(() => PaginatedInventory, { name: 'myInventory' })
  async getMyInventory(
    @Args('filter', { type: () => InventoryFilterInput, nullable: true })
    filter: InventoryFilterInput,
    @CurrentUser() user: User,
    @ActiveBranch() activeBranchId: string | null,
  ) {
    return this.inventoryService.findAll(
      this.getMerchantId(user),
      this.getBranchIds(user, activeBranchId),
      filter,
    );
  }

  @Query(() => Inventory, { name: 'getInventory' })
  async getInventory(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ) {
    return this.inventoryService.findById(id, this.getMerchantId(user));
  }

  @Query(() => [InventoryTransaction], { name: 'inventoryTransactions' })
  async getInventoryTransactions(
    @Args('inventoryId', { type: () => ID }) inventoryId: string,
    @CurrentUser() user: User,
  ) {
    return this.inventoryService.getTransactions(
      inventoryId,
      this.getMerchantId(user),
    );
  }

  @Query(() => PaginatedTransactions, { name: 'allInventoryTransactions' })
  async getAllInventoryTransactions(
    @Args('filter', { type: () => TransactionFilterInput, nullable: true })
    filter: TransactionFilterInput,
    @CurrentUser() user: User,
  ) {
    return this.inventoryService.findAllTransactions(
      this.getMerchantId(user),
      filter,
    );
  }

  @RequirePermissions('inventory_edit')
  @UseGuards(PermissionsGuard)
  @Mutation(() => Inventory)
  async updateInventory(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateInventoryInput,
    @CurrentUser() user: User,
  ) {
    return this.inventoryService.update(id, this.getMerchantId(user), input);
  }

  @RequirePermissions('inventory_edit')
  @UseGuards(PermissionsGuard)
  @Mutation(() => Inventory)
  async restockInventory(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: RestockInventoryInput,
    @CurrentUser() user: User,
  ) {
    return this.inventoryService.restock(
      id,
      this.getMerchantId(user),
      input,
      user,
    );
  }

  @RequirePermissions('inventory_edit')
  @UseGuards(PermissionsGuard)
  @Mutation(() => Inventory)
  async adjustInventory(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: AdjustInventoryInput,
    @CurrentUser() user: User,
  ) {
    return this.inventoryService.adjust(
      id,
      this.getMerchantId(user),
      input,
      user,
    );
  }

  @RequirePermissions('inventory_edit')
  @UseGuards(PermissionsGuard)
  @Mutation(() => Inventory)
  async damageInventory(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: DamageInventoryInput,
    @CurrentUser() user: User,
  ) {
    return this.inventoryService.damage(
      id,
      this.getMerchantId(user),
      input,
      user,
    );
  }

  @RequirePermissions('inventory_archive')
  @UseGuards(PermissionsGuard)
  @Mutation(() => Inventory)
  async archiveInventory(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ) {
    return this.inventoryService.archive(id, this.getMerchantId(user));
  }

  @RequirePermissions('inventory_archive')
  @UseGuards(PermissionsGuard)
  @Mutation(() => Inventory)
  async restoreInventory(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ) {
    return this.inventoryService.restore(id, this.getMerchantId(user));
  }
}
