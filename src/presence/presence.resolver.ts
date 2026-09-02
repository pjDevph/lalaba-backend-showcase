import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { PresenceService } from './presence.service';
import { PresenceStatus } from './models/presence-status.model';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';

// No @Roles restriction: presence is deliberately open to every authenticated
// role — customer, merchant, washer, courier, admin, support — both to report
// its own heartbeat and to read anyone else's coarse online/offline signal.
@Resolver(() => PresenceStatus)
@UseGuards(GqlAuthGuard)
export class PresenceResolver {
  constructor(private readonly presenceService: PresenceService) {}

  @Mutation(() => Boolean, { name: 'pingPresence' })
  async pingPresence(@CurrentUser() user: User): Promise<boolean> {
    await this.presenceService.ping(user._id);
    return true;
  }

  @Query(() => PresenceStatus, { name: 'presence' })
  async presence(
    @Args('uid', { type: () => ID }) uid: string,
  ): Promise<PresenceStatus> {
    return this.presenceService.getStatus(uid);
  }
}
