import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { BadRequestException, UseGuards } from '@nestjs/common';
import { WasherServiceOfferingsService } from './washer-service-offerings.service';
import { WasherServiceOffering } from './schemas/washer-service-offering.schema';
import { SetWasherServiceOfferingInput } from './dto/set-washer-service-offering.input';
import { WasherService } from '../washer/washer.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';

@Resolver(() => WasherServiceOffering)
@UseGuards(GqlAuthGuard, RolesGuard)
export class WasherServiceOfferingsResolver {
  constructor(
    private readonly offeringsService: WasherServiceOfferingsService,
    private readonly washerService: WasherService,
  ) {}

  // Always derived from the caller's own profile, never client-supplied — a
  // washer can only price her own services.
  private async resolveOwnBranchId(user: User): Promise<string> {
    const profile = await this.washerService.getProfile(user._id);
    if (!profile.branchId) {
      throw new BadRequestException(
        'Your shop is still being set up. Try again in a moment.',
      );
    }
    return profile.branchId;
  }

  @Roles('washer')
  @Query(() => [WasherServiceOffering], { name: 'myWasherServiceOfferings' })
  async myWasherServiceOfferings(
    @CurrentUser() user: User,
  ): Promise<WasherServiceOffering[]> {
    return this.offeringsService.listForBranch(
      await this.resolveOwnBranchId(user),
    );
  }

  @Roles('washer')
  @Mutation(() => WasherServiceOffering)
  async setWasherServiceOffering(
    @Args('input') input: SetWasherServiceOfferingInput,
    @CurrentUser() user: User,
  ): Promise<WasherServiceOffering> {
    return this.offeringsService.setOffering(
      await this.resolveOwnBranchId(user),
      input,
    );
  }

  @Roles('washer')
  @Mutation(() => Boolean)
  async removeWasherServiceOffering(
    @Args('serviceTemplateId', { type: () => ID }) serviceTemplateId: string,
    @CurrentUser() user: User,
  ): Promise<boolean> {
    return this.offeringsService.removeOffering(
      await this.resolveOwnBranchId(user),
      serviceTemplateId,
    );
  }
}
