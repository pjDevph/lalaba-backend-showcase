import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Inject,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Role, RoleDocument } from '../users/schemas/role.schema';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import { FirebaseService } from '../firebase/firebase.service';
import { EmailService } from '../email/email.service';
import { CreateStaffInput, InvitableStaffRole } from './dto/create-staff.input';
import { UpdateStaffInput } from './dto/update-staff.input';
import { StaffFilterInput } from './dto/staff-filter.input';
import { PaginatedStaff } from './models/paginated-staff.model';
import {
  Permission,
  PermissionDocument,
} from '../permissions/schemas/permission.schema';
import {
  PermissionGroup,
  expandGroups,
  groupsFromNames,
} from '../permissions/permission-groups';
import {
  BranchAccessEntry,
  deriveGrantFields,
} from '../users/branch-access.util';
import { BranchAccessInput } from './dto/branch-access.input';

@Injectable()
export class StaffService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Role.name) private readonly roleModel: Model<RoleDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    @InjectModel(Permission.name)
    private readonly permissionModel: Model<PermissionDocument>,
    private readonly firebaseService: FirebaseService,
    private readonly emailService: EmailService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // Cache invalidation is load-bearing for AUTHORIZATION now, not just for
  // display: PermissionsGuard reads branchAccess off the cached user document.
  // Skipping this would leave a revoked group working until the entry ages out.
  // Revocation is therefore eventually consistent within the 5-minute user TTL,
  // the same window isActive has always had.
  private async invalidateUserCache(uid: string): Promise<void> {
    await this.cache.del(`user:${uid}`);
  }

  /** permissionName -> _id for the whole catalogue, in one query. */
  private async permissionIdsByName(): Promise<Map<string, string>> {
    const rows = await this.permissionModel
      .find()
      .select('_id permissionName')
      .lean()
      .exec();
    return new Map(rows.map((r) => [r.permissionName, String(r._id)]));
  }

  /** Turn owner-chosen groups into the permission ids they stand for. */
  private async entriesFromGroups(
    branchAccess: readonly BranchAccessInput[],
  ): Promise<BranchAccessEntry[]> {
    const byName = await this.permissionIdsByName();
    return branchAccess.map((entry) => ({
      branchId: entry.branchId,
      permissionIds: expandGroups(entry.groups)
        .map((name) => byName.get(name))
        .filter((id): id is string => !!id),
    }));
  }

  /**
   * Project a staff document's stored grants back into groups for the client.
   *
   * ANY member of a group switches it on — see groupsFromNames. Stored grants
   * are whole groups in practice, because that is the only shape this API can
   * write; partial holdings exist only on rows the backfill has not touched.
   */
  private async withBranchAccessGroups<T extends User>(staff: T): Promise<T> {
    const access = (staff as unknown as { branchAccess?: BranchAccessEntry[] })
      .branchAccess;
    if (!access?.length) return staff;

    const byName = await this.permissionIdsByName();
    const nameById = new Map(
      [...byName.entries()].map(([name, id]) => [id, name]),
    );
    const projected = access.map((entry) => ({
      branchId: String(entry.branchId),
      groups: groupsFromNames(
        (entry.permissionIds ?? [])
          .map((id) => nameById.get(String(id)))
          .filter((n): n is string => !!n),
      ),
    }));
    // Assigned onto the returned document so the GraphQL layer sees groups
    // where the schema declares them.
    (staff as unknown as { branchAccess: unknown }).branchAccess = projected;
    return staff;
  }

  /**
   * The grant entries an update should write, or undefined to leave them alone.
   *
   * Three shapes reach this, and the order matters because older app builds are
   * still in the field:
   *
   *  1. `branchAccess` — the real thing. Authoritative whenever present.
   *  2. `permissionIds` — pre-rollout builds. One account-global list, so it is
   *     applied to every branch, reproducing exactly what it used to mean.
   *  3. `branchIds` alone — a pre-rollout reassignment. Surviving branches KEEP
   *     their existing grants and new ones start empty. Deriving from scratch
   *     here instead would silently wipe every permission the owner had set,
   *     which is the failure this clause exists to prevent.
   */
  private async resolveGrantEntries(
    input: UpdateStaffInput,
    existing: User,
  ): Promise<BranchAccessEntry[] | undefined> {
    if (input.branchAccess) {
      return this.entriesFromGroups(input.branchAccess);
    }

    const current =
      (existing as unknown as { branchAccess?: BranchAccessEntry[] })
        .branchAccess ?? [];

    if (input.permissionIds) {
      const branchIds =
        input.branchIds ?? current.map((e) => String(e.branchId));
      return branchIds.map((branchId) => ({
        branchId,
        permissionIds: input.permissionIds!,
      }));
    }

    if (input.branchIds) {
      return input.branchIds.map((branchId) => ({
        branchId,
        permissionIds:
          current.find((e) => String(e.branchId) === String(branchId))
            ?.permissionIds ?? [],
      }));
    }

    return undefined;
  }

  private async findOwnedStaff(
    id: string,
    merchantId: string,
  ): Promise<UserDocument> {
    const filter: any = { _id: id, merchantId };
    const staff = await this.userModel.findOne(filter).populate('role').exec();
    if (!staff) throw new NotFoundException('Staff not found');
    return staff;
  }

  private async validateBranches(
    branchIds: string[],
    merchantId: string,
  ): Promise<void> {
    const branches = await this.branchModel
      .find({
        _id: { $in: branchIds },
        uid: merchantId,
        isActive: true,
      } as any)
      .exec();
    if (branches.length !== branchIds.length) {
      throw new BadRequestException(
        'One or more branches do not belong to you or are not active',
      );
    }
  }

  async createStaff(
    input: CreateStaffInput,
    merchantId: string,
    ownerRoleId?: string,
  ): Promise<User> {
    const requestedRole = input.role ?? InvitableStaffRole.STAFF;

    // A home washer may invite couriers only. She has no shop floor, no POS and
    // no second branch, so a 'staff' account would be provisioned straight onto
    // screens that do not apply to her business — and would carry the POS
    // permission defaults with it.
    //
    // The role comes from the caller because GqlAuthGuard/RolesGuard have
    // already loaded and populated it (RolesGuard reads user.role.roleId to let
    // the request through at all). Re-reading it here would be a second query
    // whose failure mode is worse than its cost: a missed lookup would resolve
    // to "not a washer" and quietly permit exactly what this blocks.
    if (
      ownerRoleId === 'washer' &&
      requestedRole !== InvitableStaffRole.COURIER
    ) {
      throw new BadRequestException(
        'Home washers can only invite couriers, not staff.',
      );
    }

    const staffRole = await this.roleModel
      .findOne({ roleId: requestedRole })
      .exec();
    if (!staffRole)
      throw new BadRequestException(
        'Unable to create staff account. Please try again.',
      );

    // A courier holds no merchant permissions — their capability comes from
    // @Roles('courier') plus per-order assignment, never from this catalogue.
    // Offering groups for one would write grants that nothing reads, and imply
    // an access model the courier app does not have.
    if (
      requestedRole === InvitableStaffRole.COURIER &&
      input.branchAccess?.some((entry) => entry.groups?.length)
    ) {
      throw new BadRequestException(
        'Couriers cannot be granted permissions — their access is pickup and delivery only.',
      );
    }

    const grantEntries: BranchAccessEntry[] = input.branchAccess?.length
      ? await this.entriesFromGroups(input.branchAccess)
      : (input.branchIds ?? []).map((branchId) => ({
          branchId,
          permissionIds: [],
        }));

    const grants = deriveGrantFields(grantEntries);
    if (grants.branchIds.length) {
      await this.validateBranches(grants.branchIds.map(String), merchantId);
    }

    const tempPassword =
      Math.random().toString(36).slice(-10) +
      Math.random().toString(36).slice(-10).toUpperCase() +
      '0!';

    let firebaseUid: string;
    try {
      const firebaseUser = await this.firebaseService.getAuth().createUser({
        email: input.email,
        password: tempPassword,
        displayName: `${input.firstName} ${input.lastName}`,
        disabled: false,
      });
      firebaseUid = firebaseUser.uid;
    } catch (error: any) {
      if (error.code === 'auth/email-already-exists') {
        throw new ConflictException('A user with this email already exists');
      }
      throw new BadRequestException(
        'Account creation failed. Please try again.',
      );
    }

    try {
      const staff = new this.userModel({
        _id: firebaseUid,
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        phoneNumber: input.phoneNumber,
        role: staffRole._id,
        merchantId,
        // branchAccess plus its two derived mirrors, written as one unit.
        ...grants,
        isActive: true,
        isArchived: false,
      });
      const saved = await staff.save();
      const resetLink = await this.firebaseService
        .getAuth()
        .generatePasswordResetLink(input.email);
      await this.emailService.sendStaffInvite({
        to: input.email,
        firstName: input.firstName,
        resetLink,
      });
      const populated = await saved.populate('role');
      return this.withBranchAccessGroups(populated.toObject());
    } catch (error) {
      await this.firebaseService.getAuth().deleteUser(firebaseUid);
      throw error;
    }
  }

  async findAllByMerchant(
    merchantId: string,
    filter: StaffFilterInput = {},
  ): Promise<PaginatedStaff> {
    const {
      search,
      branchId,
      roleId,
      isArchived,
      isActive,
      limit = 10,
      offset = 0,
    } = filter;
    const safeLimit = Math.min(limit ?? 10, 100);
    const query: Record<string, any> = { merchantId };
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { firstName: { $regex: escaped, $options: 'i' } },
        { lastName: { $regex: escaped, $options: 'i' } },
        { email: { $regex: escaped, $options: 'i' } },
      ];
    }
    if (branchId) query.branchIds = new Types.ObjectId(branchId);
    if (roleId) {
      const role = await this.roleModel.findOne({ roleId }).exec();
      query.role = role?._id ?? null;
    }
    if (isArchived !== undefined) query.isArchived = isArchived;
    if (isActive !== undefined) query.isActive = isActive;

    const [data, total] = await Promise.all([
      this.userModel.find(query).skip(offset).limit(safeLimit).lean().exec(),
      this.userModel.countDocuments(query).exec(),
    ]);
    const projected = await Promise.all(
      data.map((row) => this.withBranchAccessGroups(row as unknown as User)),
    );
    return { data: projected, total, limit, offset } as PaginatedStaff;
  }

  async findById(id: string, merchantId: string): Promise<User> {
    const staff = await this.findOwnedStaff(id, merchantId);
    return this.withBranchAccessGroups(staff.toObject());
  }

  async updateStaff(
    id: string,
    merchantId: string,
    input: UpdateStaffInput,
  ): Promise<User> {
    const existing = await this.findOwnedStaff(id, merchantId);

    const entries = await this.resolveGrantEntries(input, existing);

    const updateData: Record<string, any> = { ...input };
    // The three grant fields are never set from `input` directly — only
    // deriveGrantFields may write them, and only together.
    delete updateData.branchAccess;
    delete updateData.branchIds;
    delete updateData.permissionIds;

    if (entries) {
      const grants = deriveGrantFields(entries);
      if (grants.branchIds.length) {
        await this.validateBranches(grants.branchIds.map(String), merchantId);
      }
      Object.assign(updateData, grants);
    }

    const updated = await this.userModel
      .findByIdAndUpdate(id, { $set: updateData }, { new: true })
      .exec();
    await this.invalidateUserCache(id);
    return this.withBranchAccessGroups(updated!.toObject());
  }

  async archiveStaff(id: string, merchantId: string): Promise<User> {
    const staff = await this.findOwnedStaff(id, merchantId);
    if (staff.isArchived) return staff; // already archived — idempotent
    const updated = await this.userModel
      .findByIdAndUpdate(
        id,
        { $set: { isArchived: true, archivedAt: new Date() } },
        { new: true },
      )
      .exec();
    await this.invalidateUserCache(id);
    return updated!;
  }

  async restoreStaff(id: string, merchantId: string): Promise<User> {
    const staff = await this.findOwnedStaff(id, merchantId);
    if (!staff.isArchived) return staff; // already active — idempotent
    const updated = await this.userModel
      .findByIdAndUpdate(
        id,
        { $set: { isArchived: false, archivedAt: null } },
        { new: true },
      )
      .exec();
    await this.invalidateUserCache(id);
    return updated!;
  }

  async generatePasswordResetLink(
    id: string,
    merchantId: string,
  ): Promise<string> {
    const staff = await this.findOwnedStaff(id, merchantId);
    if (staff.isArchived) {
      throw new BadRequestException(
        'Cannot reset password for an archived staff account.',
      );
    }
    return this.firebaseService
      .getAuth()
      .generatePasswordResetLink(staff.email);
  }
}
