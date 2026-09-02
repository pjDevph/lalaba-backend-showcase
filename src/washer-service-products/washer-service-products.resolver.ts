import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { WasherServiceProductsService } from './washer-service-products.service';
import { ServiceProductDefault } from './schemas/service-product-default.schema';
import { ServiceProductSlot } from './models/service-product-slot.model';
import { SetServiceProductDefaultInput } from './dto/set-service-product-default.input';
import { InventoryCategory } from '../inventory/schemas/inventory.schema';
import { WasherService } from '../washer/washer.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';

@Resolver(() => ServiceProductDefault)
@UseGuards(GqlAuthGuard, RolesGuard)
export class WasherServiceProductsResolver {
  constructor(
    private readonly serviceProductsService: WasherServiceProductsService,
    private readonly washerService: WasherService,
  ) {}

  // branchId is always derived from the caller's own profile — never
  // client-supplied — so a washer can only ever configure her own slots.
  private async resolveOwnBranchId(user: User): Promise<string> {
    const profile = await this.washerService.getProfile(user._id);
    return profile.branchId;
  }

  @Roles('washer')
  @Mutation(() => ServiceProductDefault)
  async setServiceProductDefault(
    @Args('input') input: SetServiceProductDefaultInput,
    @CurrentUser() user: User,
  ): Promise<ServiceProductDefault> {
    const branchId = await this.resolveOwnBranchId(user);
    return this.serviceProductsService.setDefault(branchId, input);
  }

  @Roles('washer')
  @Mutation(() => Boolean)
  async removeServiceProductDefault(
    @Args('serviceTemplateId', { type: () => ID }) serviceTemplateId: string,
    @Args('category', { type: () => InventoryCategory })
    category: InventoryCategory,
    @CurrentUser() user: User,
  ): Promise<boolean> {
    const branchId = await this.resolveOwnBranchId(user);
    return this.serviceProductsService.removeDefault(
      branchId,
      serviceTemplateId,
      category,
    );
  }

  // Customer-facing (and washer-facing, to preview her own setup): the
  // slots configured for a given service at a given branch.
  @Roles('washer', 'customer')
  @Query(() => [ServiceProductSlot], { name: 'serviceProductSlots' })
  async serviceProductSlots(
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('serviceTemplateId', { type: () => ID }) serviceTemplateId: string,
  ): Promise<ServiceProductSlot[]> {
    return this.serviceProductsService.getSlotsForService(
      branchId,
      serviceTemplateId,
    );
  }
}
