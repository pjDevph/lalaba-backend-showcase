import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Inject,
  forwardRef,
  OnModuleInit,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Device, DeviceDocument, DeviceStatus } from './schemas/device.schema';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { OwnerInfo } from './models/owner-info.model';
import { NotificationsService } from '../notifications/notifications.service';
import {
  NotificationCategory,
  NotificationType,
} from '../notifications/notification.enums';
import { CreateDeviceInput } from './dto/create-device.input';
import { UpdateDeviceInput } from './dto/update-device.input';

const DEVICE_AUTH_TTL = 5 * 60 * 1000; // 5 minutes

/** The device gate's answer: may this request proceed, and as whom, where. */
export interface DeviceAuthResult {
  authorized: boolean;
  /** The branch this device is approved for — selects the caller's grants. */
  branchId: string | null;
  /** The staff the device was registered to. Null on legacy rows. */
  staffUid: string | null;
}

export interface BranchOption {
  _id: string;
  name: string;
}

@Injectable()
export class DevicesService implements OnModuleInit {
  constructor(
    @InjectModel(Device.name)
    private readonly deviceModel: Model<DeviceDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @Inject(forwardRef(() => NotificationsService))
    private readonly notifications: NotificationsService,
    @Inject(forwardRef(() => UsersService))
    private readonly users: UsersService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // Backfill `status` on devices created before the field existed, so every
  // returned Device satisfies the non-nullable GraphQL field. Idempotent —
  // after the first run nothing matches.
  async onModuleInit(): Promise<void> {
    await this.deviceModel
      .updateMany(
        { status: { $exists: false }, isActive: true },
        { $set: { status: DeviceStatus.APPROVED } },
      )
      .exec();
    await this.deviceModel
      .updateMany(
        { status: { $exists: false }, isActive: { $ne: true } },
        { $set: { status: DeviceStatus.BLOCKED } },
      )
      .exec();
    // Devices created before single-active-device existed must default to
    // active, or the tightened auth gate would lock them all out at once.
    await this.deviceModel
      .updateMany(
        { activeSession: { $exists: false } },
        { $set: { activeSession: true } },
      )
      .exec();
  }

  // `_v2` because the cached VALUE changed shape, from a bare boolean to a
  // DeviceAuthResult. Reusing the old key would hand the guard a boolean where
  // it expects an object, `.authorized` would read undefined, and every staff
  // member in the field would be signed out until the entries aged out. Same
  // reasoning as the `firebase_token_v2` bump in GqlAuthGuard.
  private deviceAuthCacheKey(merchantId: string, fcmToken: string): string {
    return `device_auth_v2:${merchantId}:${fcmToken}`;
  }

  private async invalidateDeviceAuth(
    merchantId: string,
    fcmToken: string,
  ): Promise<void> {
    await this.cache.del(this.deviceAuthCacheKey(merchantId, fcmToken));
  }

  // Owner-scoped lookup: a device the given merchant owns (uid === merchantId).
  private async findOwned(
    id: string,
    merchantId: string,
  ): Promise<DeviceDocument> {
    const device = await this.deviceModel.findById(id).exec();
    if (!device || device.uid !== merchantId)
      throw new NotFoundException('Device not found');
    return device;
  }

  // ─── Registration ───────────────────────────────────────────────────────────
  // Staff self-register a device to a branch → PENDING (owner must approve).
  // Owner-registered devices are APPROVED immediately.
  async register(input: CreateDeviceInput, actor: User): Promise<Device> {
    const merchantId = actor.merchantId ?? actor._id;
    const isStaff = merchantId !== actor._id;

    if (!input.branchId)
      throw new BadRequestException(
        'A branch is required to register a device',
      );

    // The branch must belong to this merchant, and — for staff — must be one
    // the staff is actually assigned to.
    const branch = await this.branchModel.findById(input.branchId).exec();
    if (!branch || branch.uid !== merchantId)
      throw new BadRequestException('Selected branch does not exist');
    if (isStaff) {
      const assigned = (actor.branchIds ?? []).map((b) => String(b));
      if (!assigned.includes(String(input.branchId)))
        throw new ForbiddenException(
          'You are not assigned to the selected branch',
        );
    }

    const existing = await this.deviceModel
      .findOne({ uid: merchantId, fcmToken: input.fcmToken })
      .exec();
    if (existing)
      throw new BadRequestException(
        existing.staffUid === actor._id
          ? 'This device is already registered'
          : 'This device is already registered to another account',
      );

    const staffName =
      `${actor.firstName ?? ''} ${actor.lastName ?? ''}`.trim() || 'Staff';
    const status = isStaff ? DeviceStatus.PENDING : DeviceStatus.APPROVED;

    const device = new this.deviceModel({
      uid: merchantId,
      staffUid: actor._id,
      staffName,
      branchId: input.branchId,
      deviceName: input.deviceName,
      operatingSystem: input.operatingSystem,
      deviceModel: input.deviceModel ?? '',
      fcmToken: input.fcmToken,
      status,
      isActive: status === DeviceStatus.APPROVED,
    });
    const saved = await device.save();
    await this.invalidateDeviceAuth(merchantId, input.fcmToken);

    // Notify the branch owner (the merchant) that a device is awaiting approval.
    if (isStaff) {
      void this.notifications.notify(
        { uid: merchantId },
        {
          type: NotificationType.DEVICE_REGISTRATION,
          category: NotificationCategory.DEVICE,
          title: 'New device pending approval',
          body: `${staffName} registered ${input.deviceModel || input.deviceName} for ${branch.branchName}.`,
          data: {
            deviceId: String(saved._id),
            branchId: String(input.branchId),
          },
        },
      );
    }
    return saved;
  }

  // ─── Reads ────────────────────────────────────────────────────────────────
  async findAllByMerchant(merchantId: string): Promise<Device[]> {
    return this.deviceModel
      .find({ uid: merchantId })
      .sort({ createdAt: -1 })
      .exec();
  }

  async findByBranch(merchantId: string, branchId: string): Promise<Device[]> {
    return this.deviceModel
      .find({ uid: merchantId, branchId })
      .sort({ createdAt: -1 })
      .exec();
  }

  // The single device making the current request (staff polls this for status).
  async findMyDevice(
    merchantId: string,
    fcmToken: string,
  ): Promise<Device | null> {
    return this.deviceModel.findOne({ uid: merchantId, fcmToken }).exec();
  }

  // Re-send the "pending approval" push to the owner for the caller's own
  // pending device (staff taps "Notify owner again" on the waiting screen).
  async remindApproval(
    actor: User,
    fcmToken: string | undefined,
  ): Promise<boolean> {
    if (!fcmToken) return false;
    const merchantId = actor.merchantId ?? actor._id;
    const device = await this.deviceModel
      .findOne({ uid: merchantId, fcmToken, status: DeviceStatus.PENDING })
      .exec();
    if (!device) return false;
    const branch = device.branchId
      ? await this.branchModel.findById(device.branchId).exec()
      : null;
    const staffName = device.staffName || 'A staff member';
    void this.notifications.notify(
      { uid: merchantId },
      {
        type: NotificationType.DEVICE_REGISTRATION,
        category: NotificationCategory.DEVICE,
        title: 'Device approval reminder',
        body: `${staffName} is still waiting for you to approve their device${branch ? ` for ${branch.branchName}` : ''}.`,
        data: {
          deviceId: String(device._id),
          branchId: String(device.branchId ?? ''),
        },
      },
    );
    return true;
  }

  // The owner/merchant who will approve this staff's device (name only).
  async getOwnerInfo(actor: User): Promise<OwnerInfo | null> {
    const merchantId = actor.merchantId ?? actor._id;
    const owner = await this.userModel.findById(merchantId).exec();
    if (!owner) return null;
    const name =
      `${owner.firstName ?? ''} ${owner.lastName ?? ''}`.trim() ||
      'Store owner';
    return { name };
  }

  // Branch options for a staff's registration dropdown (id + name only).
  async getStaffBranchOptions(actor: User): Promise<BranchOption[]> {
    const merchantId = actor.merchantId ?? actor._id;
    const ids = (actor.branchIds ?? []).map((b) => String(b));
    if (!ids.length) return [];
    const branches = await this.branchModel
      .find({ uid: merchantId, isActive: true, _id: { $in: ids } } as any)
      .select('_id branchName')
      .exec();
    return branches.map((b) => ({ _id: String(b._id), name: b.branchName }));
  }

  // ─── Owner approval actions ─────────────────────────────────────────────────
  async approve(id: string, merchantId: string): Promise<Device> {
    const device = await this.findOwned(id, merchantId);
    const updated = await this.deviceModel
      .findByIdAndUpdate(
        id,
        {
          $set: {
            status: DeviceStatus.APPROVED,
            isActive: true,
            activeSession: true,
          },
        },
        { new: true },
      )
      .exec();
    await this.invalidateDeviceAuth(merchantId, device.fcmToken);
    // The newly approved device becomes the staff's single active session —
    // supersede any device they were previously using and prune its push token.
    if (device.staffUid) {
      const superseded = await this.supersedeSiblingDevices(
        merchantId,
        device.staffUid,
        device,
      );
      if (superseded.length)
        await this.users.removeFcmTokens(device.staffUid, superseded);
    }
    return updated!;
  }

  // Reject a pending registration — removes it so the staff can re-register.
  async disapprove(id: string, merchantId: string): Promise<boolean> {
    const device = await this.findOwned(id, merchantId);
    await this.deviceModel.findByIdAndDelete(id).exec();
    await this.invalidateDeviceAuth(merchantId, device.fcmToken);
    return true;
  }

  async block(id: string, merchantId: string): Promise<Device> {
    const device = await this.findOwned(id, merchantId);
    const updated = await this.deviceModel
      .findByIdAndUpdate(
        id,
        { $set: { status: DeviceStatus.BLOCKED, isActive: false } },
        { new: true },
      )
      .exec();
    // Clearing the cache makes the staff's NEXT request fail the auth gate →
    // the app signs them out.
    await this.invalidateDeviceAuth(merchantId, device.fcmToken);
    return updated!;
  }

  async unblock(id: string, merchantId: string): Promise<Device> {
    const device = await this.findOwned(id, merchantId);
    const updated = await this.deviceModel
      .findByIdAndUpdate(
        id,
        {
          $set: {
            status: DeviceStatus.APPROVED,
            isActive: true,
            activeSession: true,
          },
        },
        { new: true },
      )
      .exec();
    await this.invalidateDeviceAuth(merchantId, device.fcmToken);
    return updated!;
  }

  async delete(id: string, merchantId: string): Promise<boolean> {
    const device = await this.findOwned(id, merchantId);
    await this.deviceModel.findByIdAndDelete(id).exec();
    await this.invalidateDeviceAuth(merchantId, device.fcmToken);
    return true;
  }

  async update(
    id: string,
    merchantId: string,
    input: UpdateDeviceInput,
  ): Promise<Device> {
    const device = await this.findOwned(id, merchantId);
    const updated = await this.deviceModel
      .findByIdAndUpdate(id, { $set: input }, { new: true })
      .exec();
    await this.invalidateDeviceAuth(merchantId, device.fcmToken);
    return updated!;
  }

  // ─── Auth gate ──────────────────────────────────────────────────────────────
  /**
   * Resolve a device token to an authorization decision AND the identity facts
   * that decision carries.
   *
   * The branch matters as much as the boolean now: a staff member's permissions
   * are granted per branch, and the approved device is what says which branch
   * they are working. So this returns `branchId` and `staffUid` rather than just
   * "yes" — see the staffUid check in GqlAuthGuard for why the owner alone is
   * no longer a sufficient match.
   */
  async resolveDeviceAuth(
    merchantId: string,
    fcmToken: string,
  ): Promise<DeviceAuthResult> {
    const cacheKey = this.deviceAuthCacheKey(merchantId, fcmToken);
    const cached = await this.cache.get<DeviceAuthResult>(cacheKey);
    if (cached) return cached;

    const device = await this.deviceModel
      .findOne({ uid: merchantId, fcmToken })
      .exec();
    // Authorized only when APPROVED *and* still holding the active session
    // (single-active-device). Legacy rows created before `status`/`activeSession`
    // existed fall back to isActive / treat a missing flag as active.
    const authorized =
      !!device &&
      device.activeSession !== false &&
      (device.status === DeviceStatus.APPROVED ||
        (device.status == null && device.isActive === true));
    const result: DeviceAuthResult = {
      authorized,
      branchId: authorized && device?.branchId ? String(device.branchId) : null,
      staffUid: authorized && device?.staffUid ? String(device.staffUid) : null,
    };

    await this.cache.set(cacheKey, result, DEVICE_AUTH_TTL);
    return result;
  }

  /**
   * @deprecated Use {@link resolveDeviceAuth}. Kept for callers that genuinely
   * only need the boolean; authorization paths need the branch too.
   */
  async isDeviceAuthorized(
    merchantId: string,
    fcmToken: string,
  ): Promise<boolean> {
    return (await this.resolveDeviceAuth(merchantId, fcmToken)).authorized;
  }

  // ─── Single-active-device enforcement ───────────────────────────────────────
  // Flip every OTHER device belonging to `staffUid` (under this merchant) out of
  // the active session, so each fails the auth gate on its next request and
  // auto-signs-out. Returns the superseded devices' push tokens so the caller can
  // prune them from the user's notification list.
  private async supersedeSiblingDevices(
    merchantId: string,
    staffUid: string,
    claimingDevice: DeviceDocument,
  ): Promise<string[]> {
    const filter = {
      uid: merchantId,
      staffUid,
      fcmToken: { $ne: claimingDevice.fcmToken },
      activeSession: { $ne: false },
    };
    const siblings = await this.deviceModel.find(filter).exec();
    if (!siblings.length) return [];

    await this.deviceModel
      .updateMany(filter, { $set: { activeSession: false } })
      .exec();
    // Clearing each sibling's cached auth makes its NEXT request fail the gate.
    await Promise.all(
      siblings.map((d) => this.invalidateDeviceAuth(merchantId, d.fcmToken)),
    );

    const tokens = siblings
      .map((d) => d.pushToken)
      .filter((t): t is string => !!t);

    // Facebook-style "new login on your account" security alert to the device(s)
    // being signed out — sent to their OWN push tokens (sending to the whole
    // user would also ping the device that just logged in). Names the device and
    // branch that took over so staff can tell if it wasn't them. Best-effort.
    if (tokens.length) {
      const branch = claimingDevice.branchId
        ? await this.branchModel.findById(claimingDevice.branchId).exec()
        : null;
      const where = branch?.branchName ? ` at ${branch.branchName}` : '';
      const what =
        claimingDevice.deviceModel ||
        claimingDevice.deviceName ||
        'another device';
      // Deliberately sendToTokens, NOT notify(): this targets the specific
      // devices being signed OUT, not the account. A persisted feed row would
      // land in the shared account inbox and therefore be read on the device
      // that just signed in — the one person who does not need warning about
      // this sign-in. There is nothing to remember here, only someone to warn.
      void this.notifications.sendToTokens(tokens, {
        title: 'New sign-in to your account',
        body: `Your account was just used to sign in on ${what}${where}. You've been signed out of this device — if this wasn't you, change your password.`,
        data: {
          type: 'DEVICE_SUPERSEDED',
          branchId: String(claimingDevice.branchId ?? ''),
          branchName: branch?.branchName ?? '',
          deviceId: String(claimingDevice._id),
        },
      });
    }
    return tokens;
  }

  // Called by the app on every login: mark THIS device as the staff account's
  // single active session and supersede the rest. No-op for owners (their
  // requests are not device-gated). Reachable on a currently-superseded device
  // (@AllowUnregisteredDevice on the mutation) so a staff reclaims their session
  // simply by logging back in — no owner re-approval needed.
  async claimActiveDevice(
    actor: User,
    deviceToken: string | undefined,
    pushToken?: string,
  ): Promise<Device | null> {
    if (!deviceToken) return null;
    const merchantId = actor.merchantId ?? actor._id;
    const isStaff = merchantId !== actor._id;
    if (!isStaff) return null;

    const device = await this.deviceModel
      .findOne({ uid: merchantId, fcmToken: deviceToken })
      .exec();
    // Unknown or not-yet-approved device → nothing to claim; the pending-approval
    // flow (registerDevice → owner approves) governs those.
    if (!device || device.status !== DeviceStatus.APPROVED)
      return device ?? null;

    const cleanPush = pushToken?.trim();
    const set: Record<string, unknown> = { activeSession: true };
    if (cleanPush) set.pushToken = cleanPush;
    await this.deviceModel.findByIdAndUpdate(device._id, { $set: set }).exec();
    await this.invalidateDeviceAuth(merchantId, deviceToken);

    const supersededPush = await this.supersedeSiblingDevices(
      merchantId,
      device.staffUid ?? actor._id,
      device,
    );

    // Point the user's push-token list at just this device: add ours, drop the
    // superseded devices' so kicked phones stop receiving this account's pushes.
    if (cleanPush) await this.users.addFcmToken(actor._id, cleanPush);
    const prune = supersededPush.filter((t) => t && t !== cleanPush);
    if (prune.length) await this.users.removeFcmTokens(actor._id, prune);

    return this.deviceModel.findById(device._id).exec();
  }
}
