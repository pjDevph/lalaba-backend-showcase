import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Role, RoleDocument } from '../users/schemas/role.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { CreateRoleInput } from './dto/create-role.input';
import { UpdateRoleInput } from './dto/update-role.input';
import { SignupRole } from './dto/signup-role.output';
import { SELF_REGISTRABLE_ROLE_IDS } from './self-registrable-roles';

const SEED_ROLES = [
  {
    _id: new Types.ObjectId('6a11bcb8ffd7d2160b1e53b8'),
    roleId: 'admin',
    roleName: 'admin',
    description:
      'Administrator with full system access and management privileges.',
    createdAt: new Date('2026-05-23T14:42:00.130Z'),
  },
  {
    _id: new Types.ObjectId('6a11bcb8ffd7d2160b1e53b9'),
    roleId: 'merchant',
    roleName: 'merchant',
    description:
      'Business owner managing store settings, inventory, and sales.',
    createdAt: new Date('2026-05-23T14:42:00.138Z'),
  },
  {
    _id: new Types.ObjectId('6a11bcb8ffd7d2160b1e53ba'),
    roleId: 'washer',
    roleName: 'washer',
    description:
      'Independent Home Washer provider managing her own single-shop laundry service.',
    createdAt: new Date('2026-05-23T14:42:00.142Z'),
  },
  {
    _id: new Types.ObjectId('6a11bcb8ffd7d2160b1e53bc'),
    roleId: 'staff',
    roleName: 'staff',
    description:
      'General employee managing daily operations and customer service.',
    createdAt: new Date('2026-05-23T14:42:00.151Z'),
  },
  {
    _id: new Types.ObjectId('6a11bcb8ffd7d2160b1e53bd'),
    roleId: 'customer',
    roleName: 'customer',
    description: 'Places orders with merchant branches and washers.',
    createdAt: new Date('2026-08-04T00:00:00.000Z'),
  },
  {
    _id: new Types.ObjectId('6a11bcb8ffd7d2160b1e53be'),
    roleId: 'courier',
    roleName: 'courier',
    description:
      'Handles order pickup/delivery assignments, weighs laundry at pickup, and uploads proof of delivery. Created by a merchant or washer, not self-registered.',
    createdAt: new Date('2026-08-04T00:00:00.000Z'),
  },
  {
    _id: new Types.ObjectId('6a11bcb8ffd7d2160b1e53bb'),
    roleId: 'support',
    roleName: 'support',
    description:
      'Admin panel support access for assisting merchants and washers.',
    createdAt: new Date('2026-07-29T00:00:00.000Z'),
  },
];

/**
 * The roles the platform itself depends on. Derived from SEED_ROLES rather
 * than written out again, so adding a seeded role protects it automatically.
 */
const SEED_ROLE_IDS = new Set(SEED_ROLES.map((r) => r.roleId));

@Injectable()
export class RolesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RolesService.name);

  constructor(
    @InjectModel(Role.name) private readonly roleModel: Model<RoleDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const seed of SEED_ROLES) {
      const exists = await this.roleModel
        .findOne({ roleId: seed.roleId })
        .exec();
      if (!exists) {
        await this.roleModel.create(seed as unknown as RoleDocument);
        this.logger.log(`Seeded role: ${seed.roleId}`);
      }
    }
  }

  async create(input: CreateRoleInput): Promise<Role> {
    const existing = await this.roleModel
      .findOne({ roleId: input.roleId })
      .exec();
    if (existing)
      throw new ConflictException(`Role "${input.roleId}" already exists`);
    const role = new this.roleModel(input);
    return role.save();
  }

  async findAll(): Promise<Role[]> {
    return this.roleModel.find().sort({ roleName: 1 }).exec();
  }

  /**
   * The self-registrable roles, projected down to what a sign-up screen needs
   * (SEC-004). This is the ONLY role data reachable without a token, so the
   * projection is applied in the query itself — `description` and every future
   * field on Role are never loaded, let alone returned.
   */
  async findSelfRegistrable(): Promise<SignupRole[]> {
    return this.roleModel
      .find({ roleId: { $in: SELF_REGISTRABLE_ROLE_IDS } })
      .select('_id roleId roleName')
      .sort({ roleName: 1 })
      .lean<SignupRole[]>()
      .exec();
  }

  async findById(id: string): Promise<Role> {
    const role = await this.roleModel.findById(id).exec();
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  async update(id: string, input: UpdateRoleInput): Promise<Role> {
    const role = await this.roleModel.findById(id).exec();
    if (!role) throw new NotFoundException('Role not found');
    const updated = await this.roleModel
      .findByIdAndUpdate(id, { $set: input }, { new: true })
      .exec();
    return updated!;
  }

  /**
   * Deleting a role is the most destructive thing this resolver can do, and
   * it has no undo.
   *
   * RolesGuard matches on `role.roleId`, so removing the `admin` row locks
   * every admin out of the panel permanently — `createRole` is itself
   * @Roles('admin'), so nobody left can recreate it, and recovery means
   * editing the database by hand. The same applies in miniature to every
   * other seeded role: deleting `customer` breaks sign-up, deleting `courier`
   * strands assignments.
   *
   * Second guard is plain referential integrity: a user whose `role` points at
   * a deleted row fails the guard on every request with no way to tell why.
   */
  async delete(id: string): Promise<boolean> {
    const role = await this.roleModel.findById(id).exec();
    if (!role) throw new NotFoundException('Role not found');

    if (SEED_ROLE_IDS.has(role.roleId)) {
      throw new BadRequestException(
        `"${role.roleId}" is a system role and cannot be deleted.`,
      );
    }

    const holders = await this.userModel
      .countDocuments({ role: role._id })
      .exec();
    if (holders > 0) {
      throw new BadRequestException(
        `${holders} account${holders === 1 ? '' : 's'} still use this role. Move them to another role first.`,
      );
    }

    await this.roleModel.findByIdAndDelete(id).exec();
    return true;
  }
}
