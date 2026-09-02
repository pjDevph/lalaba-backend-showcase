import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { FavoritesService } from './favorites.service';
import { ProviderCard } from '../discovery/models/provider-card.model';
import { ProviderType } from '../online-orders/schemas/order-status.enum';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';

@Resolver(() => ProviderCard)
@Roles('customer')
@UseGuards(GqlAuthGuard, RolesGuard)
export class FavoritesResolver {
  constructor(private readonly favorites: FavoritesService) {}

  @Query(() => [ProviderCard], { name: 'myFavorites' })
  async myFavorites(@CurrentUser() user: User): Promise<ProviderCard[]> {
    return this.favorites.myFavorites(user._id);
  }

  @Mutation(() => Boolean)
  async addFavorite(
    @Args('branchId', { type: () => ID }) branchId: string,
    @Args('providerType', { type: () => ProviderType })
    providerType: ProviderType,
    @CurrentUser() user: User,
  ): Promise<boolean> {
    return this.favorites.addFavorite(user._id, branchId, providerType);
  }

  @Mutation(() => Boolean)
  async removeFavorite(
    @Args('branchId', { type: () => ID }) branchId: string,
    @CurrentUser() user: User,
  ): Promise<boolean> {
    return this.favorites.removeFavorite(user._id, branchId);
  }
}
