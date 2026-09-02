import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards, ForbiddenException } from '@nestjs/common';
import { ServicesService } from './services.service';
import { Service } from './schemas/service.schema';
import { CreateServiceInput } from './dto/create-service.input';
import { UpdateServiceInput } from './dto/update-service.input';
import { ServiceFilterInput } from './dto/service-filter.input';
import { PaginatedServices } from './models/paginated-services.model';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ActiveBranch } from '../auth/decorators/active-branch.decorator';
import { User } from '../users/schemas/user.schema';
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
@Resolver(() => Service)
@Roles('merchant', 'staff')
@UseGuards(GqlAuthGuard, RolesGuard)
export class ServicesResolver {
  constructor(private readonly servicesService: ServicesService) {}

  @RequirePermissions('service_create')
  @UseGuards(PermissionsGuard)
  @Mutation(() => Service)
  async createService(
    @Args('input') input: CreateServiceInput,
    @CurrentUser() user: User,
  ) {
    return this.servicesService.create(input, user);
  }

  @Query(() => PaginatedServices, { name: 'myServices' })
  async getMyServices(
    @Args('filter', { type: () => ServiceFilterInput, nullable: true })
    filter: ServiceFilterInput,
    @CurrentUser() user: User,
    @ActiveBranch() activeBranchId: string | null,
  ) {
    return this.servicesService.findAll(
      this.servicesService.getMerchantId(user),
      this.servicesService.getBranchIds(user, activeBranchId),
      filter,
    );
  }

  @Query(() => Service, { name: 'getService' })
  async getService(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ) {
    const merchantId = this.servicesService.getMerchantId(user);
    const service = await this.servicesService.findById(id);
    // Throw for both "not found" and "not yours" — same error, same timing
    if (service?.uid !== merchantId) {
      throw new ForbiddenException('Service not found');
    }
    return service;
  }

  @RequirePermissions('service_edit')
  @UseGuards(PermissionsGuard)
  @Mutation(() => Service)
  async updateService(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateServiceInput,
    @CurrentUser() user: User,
  ) {
    return this.servicesService.update(id, user, input);
  }

  @RequirePermissions('service_archive')
  @UseGuards(PermissionsGuard)
  @Mutation(() => Service)
  async archiveService(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ) {
    return this.servicesService.archive(
      id,
      this.servicesService.getMerchantId(user),
    );
  }

  @RequirePermissions('service_archive')
  @UseGuards(PermissionsGuard)
  @Mutation(() => Service)
  async restoreService(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ) {
    return this.servicesService.restore(
      id,
      this.servicesService.getMerchantId(user),
    );
  }

  @RequirePermissions('service_archive')
  @UseGuards(PermissionsGuard)
  @Mutation(() => Service)
  async deleteService(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ) {
    return this.servicesService.delete(
      id,
      this.servicesService.getMerchantId(user),
    );
  }
}
