import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { AddressesService } from './addresses.service';
import { Address } from './schemas/address.schema';
import { CreateAddressInput } from './dto/create-address.input';
import { UpdateAddressInput } from './dto/update-address.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';

@Resolver(() => Address)
@Roles('customer')
@UseGuards(GqlAuthGuard, RolesGuard)
export class AddressesResolver {
  constructor(private readonly addressesService: AddressesService) {}

  @Query(() => [Address], { name: 'myAddresses' })
  async myAddresses(@CurrentUser() user: User): Promise<Address[]> {
    return this.addressesService.myAddresses(user._id);
  }

  @Mutation(() => Address)
  async createAddress(
    @Args('input') input: CreateAddressInput,
    @CurrentUser() user: User,
  ): Promise<Address> {
    return this.addressesService.createAddress(user._id, input);
  }

  @Mutation(() => Address)
  async updateAddress(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateAddressInput,
    @CurrentUser() user: User,
  ): Promise<Address> {
    return this.addressesService.updateAddress(id, user._id, input);
  }

  @Mutation(() => Address)
  async setDefaultAddress(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ): Promise<Address> {
    return this.addressesService.setDefaultAddress(id, user._id);
  }

  @Mutation(() => Boolean)
  async deleteAddress(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ): Promise<boolean> {
    return this.addressesService.deleteAddress(id, user._id);
  }
}
