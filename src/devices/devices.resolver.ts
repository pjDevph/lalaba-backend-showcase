import { Resolver, Query, Mutation, Args, ID, Context } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { Device } from './schemas/device.schema';
import { BranchOption } from './models/branch-option.model';
import { OwnerInfo } from './models/owner-info.model';
import { CreateDeviceInput } from './dto/create-device.input';
import { UpdateDeviceInput } from './dto/update-device.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AllowUnregisteredDevice } from '../auth/decorators/allow-unregistered-device.decorator';
import { User } from '../users/schemas/user.schema';

// Default: owner-only. The staff-facing methods override @Roles and carry
// @AllowUnregisteredDevice so a staff can bootstrap a device before approval.
@Resolver(() => Device)
@Roles('merchant')
@UseGuards(GqlAuthGuard, RolesGuard)
export class DevicesResolver {
  constructor(private readonly devicesService: DevicesService) {}

  private ownerId(user: User): string {
    return user.merchantId ?? user._id;
  }

  // ─── Staff-facing (callable before the device is approved) ──────────────────
  @Roles('merchant', 'staff')
  @AllowUnregisteredDevice()
  @Mutation(() => Device)
  async registerDevice(
    @Args('input') input: CreateDeviceInput,
    @CurrentUser() user: User,
  ) {
    return this.devicesService.register(input, user);
  }

  // The single device making this request (staff polls it for approval status).
  @Roles('merchant', 'staff')
  @AllowUnregisteredDevice()
  @Query(() => Device, { name: 'myDevice', nullable: true })
  async getMyDevice(@CurrentUser() user: User, @Context() ctx: any) {
    const token = ctx?.req?.headers?.['x-device-token'];
    if (!token) return null;
    return this.devicesService.findMyDevice(this.ownerId(user), token);
  }

  // Branch options for the staff's registration dropdown (id + name).
  @Roles('merchant', 'staff')
  @AllowUnregisteredDevice()
  @Query(() => [BranchOption], { name: 'myBranchOptions' })
  async myBranchOptions(@CurrentUser() user: User) {
    return this.devicesService.getStaffBranchOptions(user);
  }

  // The owner who will approve this staff's device (name only).
  @Roles('merchant', 'staff')
  @AllowUnregisteredDevice()
  @Query(() => OwnerInfo, { name: 'myOwner', nullable: true })
  async myOwner(@CurrentUser() user: User) {
    return this.devicesService.getOwnerInfo(user);
  }

  // Mark THIS device as the staff account's single active session (the app calls
  // it on every login). Supersedes the staff's other devices, which then
  // auto-sign-out on their next request. @AllowUnregisteredDevice so a staff on a
  // currently-superseded device can reclaim their session by logging back in.
  // No-op server-side for owners. `pushToken` links the real FCM token so a later
  // supersession can prune it.
  @Roles('merchant', 'staff')
  @AllowUnregisteredDevice()
  @Mutation(() => Device, { name: 'claimDevice', nullable: true })
  async claimDevice(
    @CurrentUser() user: User,
    @Context() ctx: any,
    @Args('pushToken', { nullable: true }) pushToken?: string,
  ) {
    const token = ctx?.req?.headers?.['x-device-token'];
    return this.devicesService.claimActiveDevice(user, token, pushToken);
  }

  // Re-notify the owner about this device's pending approval.
  @Roles('merchant', 'staff')
  @AllowUnregisteredDevice()
  @Mutation(() => Boolean)
  async remindDeviceApproval(
    @CurrentUser() user: User,
    @Context() ctx: any,
  ): Promise<boolean> {
    const token = ctx?.req?.headers?.['x-device-token'];
    return this.devicesService.remindApproval(user, token);
  }

  // ─── Owner-facing ───────────────────────────────────────────────────────────
  @Query(() => [Device], { name: 'myDevices' })
  async getMyDevices(@CurrentUser() user: User) {
    return this.devicesService.findAllByMerchant(this.ownerId(user));
  }

  @Query(() => [Device], { name: 'devicesByBranch' })
  async devicesByBranch(
    @Args('branchId', { type: () => ID }) branchId: string,
    @CurrentUser() user: User,
  ) {
    return this.devicesService.findByBranch(this.ownerId(user), branchId);
  }

  @Mutation(() => Device)
  async approveDevice(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ) {
    return this.devicesService.approve(id, this.ownerId(user));
  }

  @Mutation(() => Boolean)
  async disapproveDevice(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ) {
    return this.devicesService.disapprove(id, this.ownerId(user));
  }

  @Mutation(() => Device)
  async blockDevice(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ) {
    return this.devicesService.block(id, this.ownerId(user));
  }

  @Mutation(() => Device)
  async unblockDevice(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ) {
    return this.devicesService.unblock(id, this.ownerId(user));
  }

  @Mutation(() => Boolean)
  async deleteDevice(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ) {
    return this.devicesService.delete(id, this.ownerId(user));
  }

  @Mutation(() => Device)
  async updateDevice(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateDeviceInput,
    @CurrentUser() user: User,
  ) {
    return this.devicesService.update(id, this.ownerId(user), input);
  }
}
