import { UseGuards } from '@nestjs/common';
import { Resolver, Mutation, Args } from '@nestjs/graphql';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { AllowUnregisteredDevice } from '../auth/decorators/allow-unregistered-device.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { NotificationsService } from './notifications.service';

@Resolver()
export class NotificationsResolver {
  constructor(
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Register this device's FCM token on the signed-in user. Reachable before
   *  device approval so token registration doesn't trip the device auth gate. */
  @Mutation(() => Boolean)
  @AllowUnregisteredDevice()
  @UseGuards(GqlAuthGuard)
  async saveFcmToken(
    @Args('token') token: string,
    @CurrentUser() user: User,
  ): Promise<boolean> {
    await this.users.addFcmToken(user._id, token);
    return true;
  }

  /** Remove this device's FCM token (call on logout). */
  @Mutation(() => Boolean)
  @AllowUnregisteredDevice()
  @UseGuards(GqlAuthGuard)
  async removeFcmToken(
    @Args('token') token: string,
    @CurrentUser() user: User,
  ): Promise<boolean> {
    await this.users.removeFcmTokens(user._id, [token]);
    return true;
  }

  /**
   * Called by the app right after a staff finishes signing in. Pushes a
   * "staff signed in" notification to the staff's owner/merchant. A harmless
   * no-op for non-staff callers. Best-effort — always returns true.
   */
  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard)
  async notifyStaffLogin(@CurrentUser() user: User): Promise<boolean> {
    await this.notifications.notifyOwnerOfStaffLogin(user);
    return true;
  }
}
