import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Inject,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { randomBytes } from 'node:crypto';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { User, UserDocument } from './schemas/user.schema';
import { Role, RoleDocument } from './schemas/role.schema';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileDocument,
} from '../washer/schemas/washer-profile.schema';
import { defaultWasherStoreName } from '../washer/washer-name.util';
import { RegisterUserInput } from './dto/register-user.input';
import { UpdateUserInput } from './dto/update-user.input';
import { UserFilterInput } from './dto/user-filter.input';
import { CreateAdminUserInput } from './dto/create-admin-user.input';
import { PaginatedUsers } from './models/paginated-users.model';
import { PaginatedMerchants } from './models/paginated-merchants.model';
import { FirebaseService } from '../firebase/firebase.service';
import { SELF_REGISTRABLE_ROLE_IDS } from '../roles/self-registrable-roles';
import { ConsentsService } from '../consents/consents.service';
import { WalletsService } from '../wallets/wallets.service';

const ADMIN_PANEL_ROLES = ['admin', 'support'];

/**
 * A Mongo duplicate-key rejection on the users.email index.
 *
 * Matched on the index name rather than just code 11000: the users collection
 * has other unique indexes, and answering "this email is already registered"
 * to a clash on one of those would be actively misleading.
 */
function isDuplicateEmailError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: number; message?: string; keyPattern?: object };
  if (e.code !== 11000) return false;
  return (
    Object.prototype.hasOwnProperty.call(e.keyPattern ?? {}, 'email') ||
    /index:\s*email_1/.test(e.message ?? '')
  );
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Role.name) private readonly roleModel: Model<RoleDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    @InjectModel(WasherProfile.name)
    private readonly washerProfileModel: Model<WasherProfileDocument>,
    private readonly firebaseService: FirebaseService,
    private readonly consentsService: ConsentsService,
    private readonly walletsService: WalletsService,
    @InjectConnection() private readonly connection: Connection,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async register(input: RegisterUserInput, idToken: string): Promise<User> {
    const { role, firstName, lastName, phoneNumber, homeAddress } = input;
    let decodedToken: import('firebase-admin/auth').DecodedIdToken;

    // 1. Verify the real Firebase ID token sent from the client
    try {
      decodedToken = await this.firebaseService
        .getAuth()
        .verifyIdToken(idToken, true);
    } catch (error) {
      throw new BadRequestException('Session expired. Please log in again.');
    }

    const { uid, email } = decodedToken;

    // 2. Safeguard: Validate Role ID format
    if (!role || !Types.ObjectId.isValid(role)) {
      throw new BadRequestException('Invalid role selected.');
    }

    // 3. Verify role exists in the database
    const roleExists = await this.roleModel.findById(role).exec();
    if (!roleExists) {
      throw new BadRequestException('Invalid role selected.');
    }

    // 4. Self-registration is only allowed for specific roles
    // (customer, merchant, washer are self-registrable; staff/courier are
    // provisioned by an owner via createStaff, admin/support via createAdminUser)
    //
    // SEC-004: this list is now shared with the public `signupRoles` query, so
    // what sign-up is allowed to advertise and what registration will actually
    // accept are the same constant and cannot drift apart.
    if (!SELF_REGISTRABLE_ROLE_IDS.includes(roleExists.roleId)) {
      throw new BadRequestException('This registration type is not supported.');
    }

    // 5. If a doc already exists for this uid, return it (idempotent — handles retries after network timeouts)
    const existingUser = await this.userModel.findById(uid).exec();
    if (existingUser) return existingUser;

    // 5b. Same email, different uid. Step 5 keys on uid, so it only covers a
    // retry of the SAME Firebase identity — it cannot see an account that was
    // registered under a different one. That happens routinely in development
    // (the auth emulator is reset while Mongo keeps its data, so a familiar
    // email comes back with a fresh uid) and in production whenever someone
    // signs up again through a different provider.
    //
    // Without this the insert below reached the unique email index and threw a
    // raw E11000, which surfaced to the client as INTERNAL_SERVER_ERROR — a
    // server-fault message for what is plainly a user-correctable mistake.
    if (email) {
      const emailTaken = await this.userModel
        .findOne({ email })
        .select('_id')
        .exec();
      if (emailTaken) {
        throw new ConflictException(
          'This email is already registered. Try logging in instead.',
        );
      }
    }

    // 6. Every mandatory consent for this role must be present before the
    // account is created — never assume consent, never create the account first
    // and ask later.
    this.consentsService.assertMandatoryConsentsPresent(
      roleExists.roleId,
      input.consents,
    );

    // 7. Create the user document and record consent acceptances atomically —
    // a retried registration call short-circuits at step 5 above and never
    // re-attempts this, so this only ever runs once per account.
    const session = await this.connection.startSession();
    let saved: User;
    try {
      await session.withTransaction(async () => {
        const newUser = new this.userModel({
          _id: uid,
          email: email,
          role: new Types.ObjectId(role),
          firstName,
          lastName,
          phoneNumber,
          homeAddress, // Mongoose nesting will handle validation perfectly here
        });
        saved = await newUser.save({ session });

        await this.consentsService.recordConsents(
          uid,
          input.consents,
          'registration',
          session,
        );

        // Washer gets her shop set up eagerly at registration — a Branch
        // record purely as a technical anchor for the shared Inventory/
        // Product schema's required branchId FK (she is not conceptually a
        // "branch" anywhere else), plus her own WasherProfile.
        if (roleExists.roleId === 'washer') {
          await this.createWasherShopAnchor(uid, input, session);
        }
      });
    } catch (err) {
      // The check at 5b closes the ordinary case, but two signups racing on the
      // same email can still both pass it and reach the index. Translate that
      // last-line-of-defence rejection into the same answer rather than letting
      // a driver error escape as a 500.
      if (isDuplicateEmailError(err)) {
        throw new ConflictException(
          'This email is already registered. Try logging in instead.',
        );
      }
      throw err;
    } finally {
      await session.endSession();
    }

    return saved!;
  }

  private async createWasherShopAnchor(
    uid: string,
    input: RegisterUserInput,
    session: import('mongoose').ClientSession,
  ): Promise<void> {
    const addr = input.homeAddress;
    // One expression for both records: the anchor Branch's name and the shop
    // name customers see. `storeName` is required and has no fallback behind
    // it, so she must own one from the moment she registers — she renames it on
    // the washer app's Online Store screen.
    const storeName = defaultWasherStoreName(input.firstName);
    const branch = new this.branchModel({
      uid,
      branchName: storeName,
      branchAddress: {
        unit: addr?.unit ?? null,
        regionName: addr?.regionName || 'Not yet provided',
        provinceName: addr?.provinceName || 'Not yet provided',
        cityMunicipalityName: addr?.cityMunicipalityName || 'Not yet provided',
        barangayName: addr?.barangayName || 'Not yet provided',
        streetAddress: addr?.streetAddress || 'Not yet provided',
        zipCode: addr?.zipCode ?? null,
      },
      // Placeholder coordinates — this Branch record is never surfaced in
      // discovery; the washer's real serviceable location lives on
      // WasherProfile.address/mapLocation, set up after registration.
      branchMapLocation: { latitude: 0, longitude: 0 },
      branchPhoneNumber: input.phoneNumber,
      operatingHours: {
        monday: { isOpen: false, is24Hours: false, timeSlots: [] },
        tuesday: { isOpen: false, is24Hours: false, timeSlots: [] },
        wednesday: { isOpen: false, is24Hours: false, timeSlots: [] },
        thursday: { isOpen: false, is24Hours: false, timeSlots: [] },
        friday: { isOpen: false, is24Hours: false, timeSlots: [] },
        saturday: { isOpen: false, is24Hours: false, timeSlots: [] },
        sunday: { isOpen: false, is24Hours: false, timeSlots: [] },
      },
      isOnline: false, // stays hidden until she completes shop setup + verification
    });
    const savedBranch = await branch.save({ session });

    const profile = new this.washerProfileModel({
      uid,
      displayName: `${input.firstName} ${input.lastName}`,
      storeName,
      phone: input.phoneNumber,
      branchId: savedBranch._id,
    });
    await profile.save({ session });

    // Wallet exists from day one but stays empty and unfundable until
    // verification is approved (§17).
    await this.walletsService.createWallet(String(savedBranch._id), session);
  }

  // Make sure this method is here so your resolver's "me" query doesn't crash!
  async findOneById(uid: string): Promise<User | null> {
    return this.userModel.findById(uid).exec();
  }

  async findOneByIdWithRole(uid: string): Promise<User | null> {
    return this.userModel.findById(uid).populate('role').exec();
  }

  async findOneByIdWithRoleCached(uid: string): Promise<User | null> {
    const key = `user:${uid}`;
    const cached = await this.cache.get<User>(key);
    if (cached) return cached;
    const user = await this.userModel.findById(uid).populate('role').exec();
    if (user) await this.cache.set(key, user, 5 * 60 * 1000);
    return user;
  }

  /**
   * Drop the cached user+role document behind `findOneByIdWithRoleCached`.
   *
   * Public because the denormalized gate fields GqlAuthGuard reads (selfieStatus
   * in particular) are written by other services straight through their own
   * userModel handle. Any such writer must call this, or the guard keeps seeing
   * the pre-write document for the rest of the 5-minute TTL.
   */
  async invalidateUserCache(uid: string): Promise<void> {
    await this.cache.del(`user:${uid}`);
  }

  async updateUser(uid: string, input: UpdateUserInput): Promise<User> {
    const user = await this.userModel.findById(uid).exec();
    if (!user) throw new NotFoundException('User not found');
    const updated = await this.userModel
      .findByIdAndUpdate(uid, { $set: input }, { new: true })
      .exec();
    await this.invalidateUserCache(uid);
    return updated!;
  }

  /** Register an FCM device token on the user (idempotent — no duplicates). */
  async addFcmToken(uid: string, token: string): Promise<void> {
    const t = token?.trim();
    if (!t) return;
    await this.userModel
      .findByIdAndUpdate(uid, { $addToSet: { fcmTokens: t } })
      .exec();
    await this.invalidateUserCache(uid);
  }

  /** Remove one or more FCM device tokens from the user (used on logout and to
   *  prune tokens FCM reports as unregistered). */
  async removeFcmTokens(uid: string, tokens: string[]): Promise<void> {
    const clean = tokens.map((t) => t?.trim()).filter(Boolean);
    if (!clean.length) return;
    await this.userModel
      .findByIdAndUpdate(uid, { $pull: { fcmTokens: { $in: clean } } })
      .exec();
    await this.invalidateUserCache(uid);
  }

  async listUsers(filter: UserFilterInput = {}): Promise<PaginatedUsers> {
    const { isActive, search, role, limit = 10, offset = 0 } = filter;
    const safeLimit = Math.min(limit ?? 10, 100);
    const query: Record<string, any> = {};
    if (isActive !== undefined) query.isActive = isActive;
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { firstName: { $regex: escaped, $options: 'i' } },
        { lastName: { $regex: escaped, $options: 'i' } },
        { email: { $regex: escaped, $options: 'i' } },
      ];
    }
    if (role) {
      const roleDoc = await this.roleModel.findOne({ roleId: role }).exec();
      query.role = roleDoc ? roleDoc._id : null;
    }
    const [data, total] = await Promise.all([
      this.userModel.find(query).skip(offset).limit(safeLimit).lean().exec(),
      this.userModel.countDocuments(query).exec(),
    ]);
    return { data, total, limit, offset } as PaginatedUsers;
  }

  // Only an existing admin can call this (enforced by the resolver's
  // @Roles('admin') guard) — creates the account server-side via the
  // Firebase Admin SDK so the calling admin's own session is never touched,
  // then emails a "set your password" link via Firebase's own delivery
  // (no Resend/EmailService involved).
  async createAdminUser(input: CreateAdminUserInput): Promise<User> {
    const role = await this.roleModel.findOne({ roleId: input.role }).exec();
    if (!role) {
      throw new BadRequestException(
        'Unable to create account. Please try again.',
      );
    }

    // Nobody ever holds this: the account is reached through the
    // set-your-password email below, and a credential only exists because
    // createUser() requires one. Math.random() is not a CSPRNG and its output
    // is predictable from a known seed — not worth leaving on a live admin
    // account even for the window before the reset lands.
    const tempPassword = `${randomBytes(24).toString('base64url')}0!`;

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
      const user = new this.userModel({
        _id: firebaseUid,
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        phoneNumber: input.phoneNumber,
        role: role._id,
        isActive: true,
        isArchived: false,
      });
      const saved = await user.save();
      // Last, and allowed to fail the whole mutation: the invite IS the only
      // way into this account. Reporting success without it hands back an
      // account nobody can ever sign into.
      await this.firebaseService.sendPasswordResetEmail(input.email);
      return saved.populate('role');
    } catch (error) {
      // Roll BOTH sides back. Deleting only the Firebase user (as this did
      // before the invite could throw) strands the Mongo document: the email
      // then reads as taken by listAdminUsers while no credential exists for
      // it, and a retry hits a duplicate-key error instead of recreating.
      await this.rollbackAdminUser(firebaseUid);
      throw error;
    }
  }

  /** Best-effort undo for a half-created back-office account. Never masks the
   *  original failure — that is what the caller is about to throw. */
  private async rollbackAdminUser(firebaseUid: string): Promise<void> {
    try {
      await this.userModel.findByIdAndDelete(firebaseUid).exec();
    } catch (err) {
      this.logger.error(
        `Failed to roll back Mongo user ${firebaseUid}: ${(err as Error)?.message}`,
      );
    }
    try {
      await this.firebaseService.getAuth().deleteUser(firebaseUid);
    } catch (err) {
      this.logger.error(
        `Failed to roll back Firebase user ${firebaseUid}: ${(err as Error)?.message}`,
      );
    }
    await this.invalidateUserCache(firebaseUid);
  }

  // Scoped to admin/support only, resolved server-side. `filter.role` may
  // narrow the result to just one of those two roles, but can never widen it
  // to anything else — `support` callers hit this too and must never be able
  // to page through merchant/staff/washer accounts.
  async listAdminPanelUsers(
    filter: UserFilterInput = {},
  ): Promise<PaginatedUsers> {
    const { isActive, search, role, limit = 10, offset = 0 } = filter;
    const safeLimit = Math.min(limit ?? 10, 100);
    const allowedRoleIds =
      role && ADMIN_PANEL_ROLES.includes(role) ? [role] : ADMIN_PANEL_ROLES;
    const adminPanelRoles = await this.roleModel
      .find({ roleId: { $in: allowedRoleIds } })
      .exec();
    const query: Record<string, any> = {
      role: { $in: adminPanelRoles.map((r) => r._id) },
    };
    if (isActive !== undefined) query.isActive = isActive;
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { firstName: { $regex: escaped, $options: 'i' } },
        { lastName: { $regex: escaped, $options: 'i' } },
        { email: { $regex: escaped, $options: 'i' } },
      ];
    }
    const [data, total] = await Promise.all([
      this.userModel.find(query).skip(offset).limit(safeLimit).lean().exec(),
      this.userModel.countDocuments(query).exec(),
    ]);
    return { data, total, limit, offset } as PaginatedUsers;
  }

  // Re-sends the "set your password" email — needed since the link expires
  // (~1 hour) with no other recovery path otherwise.
  async resendAdminInvite(uid: string): Promise<void> {
    const user = await this.userModel.findById(uid).populate('role').exec();
    if (!user) throw new NotFoundException('User not found');
    if (user.isArchived) {
      throw new BadRequestException(
        'Cannot resend invite for an archived account.',
      );
    }
    const role = user.role as unknown as Role;
    if (!ADMIN_PANEL_ROLES.includes(role?.roleId)) {
      throw new BadRequestException(
        'This account is not an admin/support account.',
      );
    }
    await this.firebaseService.sendPasswordResetEmail(user.email);
  }

  // Hardcoded to the merchant role server-side (unlike listAdminPanelUsers,
  // there's no sub-filter to narrow — this query is merchants only, period).
  async listMerchants(
    filter: UserFilterInput = {},
  ): Promise<PaginatedMerchants> {
    const { isActive, search, limit = 10, offset = 0 } = filter;
    const safeLimit = Math.min(limit ?? 10, 100);
    const merchantRole = await this.roleModel
      .findOne({ roleId: 'merchant' })
      .exec();
    const query: Record<string, any> = { role: merchantRole?._id ?? null };
    if (isActive !== undefined) query.isActive = isActive;
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { firstName: { $regex: escaped, $options: 'i' } },
        { lastName: { $regex: escaped, $options: 'i' } },
        { email: { $regex: escaped, $options: 'i' } },
      ];
    }
    const [data, total] = await Promise.all([
      this.userModel.find(query).skip(offset).limit(safeLimit).lean().exec(),
      this.userModel.countDocuments(query).exec(),
    ]);

    const merchantIds = data.map((m) => m._id);
    const counts = await this.branchModel.aggregate([
      { $match: { uid: { $in: merchantIds }, isActive: true } },
      { $group: { _id: '$uid', count: { $sum: 1 } } },
    ]);
    const countById = new Map(counts.map((c) => [c._id, c.count]));

    return {
      data: data.map((m) => ({
        ...m,
        branchCount: countById.get(m._id) ?? 0,
      })),
      total,
      limit,
      offset,
    } as PaginatedMerchants;
  }

  /** Platform-wide headcount for one role, for the admin dashboard's stat bar. */
  async countByRole(roleId: string): Promise<number> {
    const role = await this.roleModel.findOne({ roleId }).exec();
    if (!role) return 0;
    return this.userModel
      .countDocuments({ role: role._id, isActive: true })
      .exec();
  }

  /**
   * End every active session for an account, immediately.
   *
   * Two halves, and both are needed:
   *
   *  1. `sessionsValidAfter` rejects the ACCESS token the caller already
   *     holds. GqlAuthGuard caches verified tokens for 50 minutes, and a
   *     Firebase access token is valid for an hour, so without this the
   *     account keeps working for up to an hour after being "logged out".
   *  2. `revokeRefreshTokens` stops them minting a NEW access token once the
   *     current one expires. Without it, half one only buys an hour.
   *
   * Invalidating the user cache last is what makes half one take effect on
   * the very next request rather than up to five minutes later.
   *
   * Firebase failures are tolerated: half one alone still ends the session
   * for the token in play, and failing the whole call would leave the admin
   * believing nothing happened when in fact the important half worked.
   */
  async revokeSessions(uid: string): Promise<User> {
    const user = await this.userModel.findById(uid).exec();
    if (!user) throw new NotFoundException('User not found');

    const now = new Date();
    const updated = await this.userModel
      .findByIdAndUpdate(
        uid,
        { $set: { sessionsValidAfter: now } },
        { new: true },
      )
      .exec();

    try {
      await this.firebaseService.getAuth().revokeRefreshTokens(uid);
    } catch (err) {
      this.logger.error(
        `Revoked local sessions for ${uid} but Firebase refresh-token revocation failed — they cannot use the current token, but could mint a new one`,
        (err as Error)?.stack,
      );
    }

    await this.invalidateUserCache(uid);
    return updated!;
  }

  /**
   * Deactivation is one of the few actions with NO in-app undo when it is
   * pointed at the wrong account: `reactivateUser` is itself @Roles('admin'),
   * so an admin who deactivates their own account — or the last remaining one
   * — locks every admin out of the panel, and the only way back is editing
   * the database by hand. Both guards below refuse rather than let that
   * happen; neither restricts deactivating anyone else.
   *
   * `actorUid` is optional so existing non-admin-targeting callers are
   * unaffected, but the resolver always passes it.
   */
  async deactivateUser(uid: string, actorUid?: string): Promise<User> {
    const user = await this.userModel.findById(uid).populate('role').exec();
    if (!user) throw new NotFoundException('User not found');
    if (!user.isActive)
      throw new BadRequestException('User is already deactivated');

    if (actorUid && actorUid === uid) {
      throw new BadRequestException(
        'You cannot deactivate your own account. Ask another admin to do it.',
      );
    }

    const role = user.role as unknown as Role;
    if (role?.roleId === 'admin') {
      const activeAdmins = await this.userModel
        .countDocuments({ role: role._id, isActive: true })
        .exec();
      if (activeAdmins <= 1) {
        throw new BadRequestException(
          'This is the last active admin. Promote another admin before deactivating this one.',
        );
      }
    }

    const updated = await this.userModel
      .findByIdAndUpdate(uid, { $set: { isActive: false } }, { new: true })
      .exec();
    await this.invalidateUserCache(uid);
    return updated!;
  }

  async reactivateUser(uid: string): Promise<User> {
    const user = await this.userModel.findById(uid).exec();
    if (!user) throw new NotFoundException('User not found');
    if (user.isActive) throw new BadRequestException('User is already active');
    const updated = await this.userModel
      .findByIdAndUpdate(uid, { $set: { isActive: true } }, { new: true })
      .exec();
    await this.invalidateUserCache(uid);
    return updated!;
  }

  /**
   * Write-through for the denormalized `washerStatus` gate field GqlAuthGuard
   * reads (same pattern as `selfieStatus`). Called by WasherService.setStatus
   * — never set this directly on the User doc elsewhere, or the cached
   * document GqlAuthGuard reads will disagree with washer_profiles.
   */
  async setWasherStatus(
    uid: string,
    washerStatus: string | null,
  ): Promise<void> {
    await this.userModel
      .findByIdAndUpdate(uid, { $set: { washerStatus } })
      .exec();
    await this.invalidateUserCache(uid);
  }
}
