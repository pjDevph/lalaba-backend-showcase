import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ProductsService } from './products.service';
import { Product } from './schemas/product.schema';
import { CreateProductInput } from './dto/create-product.input';
import { UpdateProductInput } from './dto/update-product.input';
import { ProductFilterInput } from './dto/product-filter.input';
import { PaginatedProducts } from './models/paginated-products.model';
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
@Resolver(() => Product)
@Roles('merchant', 'staff')
@UseGuards(GqlAuthGuard, RolesGuard)
export class ProductsResolver {
  constructor(private readonly productsService: ProductsService) {}

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

  @Query(() => PaginatedProducts, { name: 'myProducts' })
  async getMyProducts(
    @Args('filter', { type: () => ProductFilterInput, nullable: true })
    filter: ProductFilterInput,
    @CurrentUser() user: User,
    @ActiveBranch() activeBranchId: string | null,
  ) {
    return this.productsService.findAll(
      this.getMerchantId(user),
      this.getBranchIds(user, activeBranchId),
      filter,
    );
  }

  @RequirePermissions('product_create')
  @UseGuards(PermissionsGuard)
  @Mutation(() => Product)
  async createProduct(
    @Args('input') input: CreateProductInput,
    @CurrentUser() user: User,
  ) {
    return this.productsService.create(input, this.getMerchantId(user));
  }

  @Query(() => [Product], { name: 'inventoryProducts' })
  async getInventoryProducts(
    @Args('inventoryId', { type: () => ID }) inventoryId: string,
    @CurrentUser() user: User,
  ) {
    return this.productsService.findByInventory(
      inventoryId,
      this.getMerchantId(user),
    );
  }

  @Query(() => Product, { name: 'getProduct' })
  async getProduct(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ) {
    return this.productsService.findById(id, this.getMerchantId(user));
  }

  @RequirePermissions('product_update')
  @UseGuards(PermissionsGuard)
  @Mutation(() => Product)
  async updateProduct(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateProductInput,
    @CurrentUser() user: User,
  ) {
    return this.productsService.update(id, this.getMerchantId(user), input);
  }

  @RequirePermissions('product_archive')
  @UseGuards(PermissionsGuard)
  @Mutation(() => Product)
  async archiveProduct(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ) {
    return this.productsService.archive(id, this.getMerchantId(user));
  }

  @RequirePermissions('product_archive')
  @UseGuards(PermissionsGuard)
  @Mutation(() => Product)
  async restoreProduct(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ) {
    return this.productsService.restore(id, this.getMerchantId(user));
  }
}
