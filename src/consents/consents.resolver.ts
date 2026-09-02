import { Args, ID, Resolver, Query } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ConsentsService } from './consents.service';
import { Consent } from './schemas/consent.schema';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';

@Resolver(() => Consent)
@UseGuards(GqlAuthGuard)
export class ConsentsResolver {
  constructor(private readonly consentsService: ConsentsService) {}

  @Query(() => [Consent], { name: 'myConsents' })
  async myConsents(@CurrentUser() user: User): Promise<Consent[]> {
    return this.consentsService.myConsents(user._id);
  }

  /**
   * DSAR/compliance lookup: what has THIS person agreed to, and when — the
   * question a data-subject access or "prove they accepted the terms"
   * request actually asks. Admin/support, same audience as the account
   * directory this is meant to be read from.
   */
  @Query(() => [Consent], { name: 'userConsents' })
  @Roles('admin', 'support')
  @UseGuards(GqlAuthGuard, RolesGuard)
  async userConsents(
    @Args('uid', { type: () => ID }) uid: string,
  ): Promise<Consent[]> {
    return this.consentsService.myConsents(uid);
  }
}
