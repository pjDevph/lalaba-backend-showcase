import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Inject,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Permission, PermissionDocument } from './schemas/permission.schema';
import { CreatePermissionInput } from './dto/create-permission.input';
import { UpdatePermissionInput } from './dto/update-permission.input';
import { PERMISSION_CATALOGUE } from './permission-catalogue';

const PERMISSIONS_CACHE_KEY = 'permissions:all';
const PERMISSIONS_TTL = 60 * 60 * 1000; // 1 hour

@Injectable()
export class PermissionsService implements OnModuleInit {
  private readonly logger = new Logger(PermissionsService.name);

  constructor(
    @InjectModel(Permission.name)
    private readonly permissionModel: Model<PermissionDocument>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // Ensure every permission the app references actually exists as a row.
  // Without this the `permissions` collection is hand-populated and drifts
  // from the code: any missing name makes the merchant app silently drop
  // that grant when saving staff permissions (the id lookup returns
  // undefined), so the toggle can never be saved. Upsert-only — existing
  // rows (including manually edited descriptions) are left untouched.
  async onModuleInit(): Promise<void> {
    const ops = PERMISSION_CATALOGUE.map((p) => ({
      updateOne: {
        filter: { permissionName: p.permissionName },
        update: { $setOnInsert: p },
        upsert: true,
      },
    }));
    try {
      const result = await this.permissionModel.bulkWrite(ops, {
        ordered: false,
      });
      const inserted = result.upsertedCount ?? 0;
      if (inserted > 0) {
        await this.invalidateCache();
        this.logger.log(`Seeded ${inserted} missing permission(s).`);
      }
    } catch (err) {
      this.logger.error('Permission catalogue seed failed', err as Error);
    }
  }

  private async invalidateCache(): Promise<void> {
    await this.cache.del(PERMISSIONS_CACHE_KEY);
  }

  async create(input: CreatePermissionInput): Promise<Permission> {
    const existing = await this.permissionModel
      .findOne({ permissionName: input.permissionName })
      .exec();
    if (existing)
      throw new ConflictException(
        `Permission "${input.permissionName}" already exists`,
      );
    const permission = new this.permissionModel(input);
    const saved = await permission.save();
    await this.invalidateCache();
    return saved;
  }

  async findAll(): Promise<Permission[]> {
    const cached = await this.cache.get<Permission[]>(PERMISSIONS_CACHE_KEY);
    if (cached) return cached;
    const permissions = await this.permissionModel
      .find()
      .sort({ permissionName: 1 })
      .exec();
    await this.cache.set(PERMISSIONS_CACHE_KEY, permissions, PERMISSIONS_TTL);
    return permissions;
  }

  async findById(id: string): Promise<Permission> {
    const permission = await this.permissionModel.findById(id).exec();
    if (!permission) throw new NotFoundException('Permission not found');
    return permission;
  }

  async update(id: string, input: UpdatePermissionInput): Promise<Permission> {
    const permission = await this.permissionModel.findById(id).exec();
    if (!permission) throw new NotFoundException('Permission not found');
    if (
      input.permissionName &&
      input.permissionName !== permission.permissionName
    ) {
      const taken = await this.permissionModel
        .findOne({ permissionName: input.permissionName })
        .exec();
      if (taken)
        throw new ConflictException(
          `Permission "${input.permissionName}" already exists`,
        );
    }
    const updated = await this.permissionModel
      .findByIdAndUpdate(id, { $set: input }, { new: true })
      .exec();
    await this.invalidateCache();
    return updated!;
  }

  async delete(id: string): Promise<boolean> {
    const permission = await this.permissionModel.findById(id).exec();
    if (!permission) throw new NotFoundException('Permission not found');
    await this.permissionModel.findByIdAndDelete(id).exec();
    await this.invalidateCache();
    return true;
  }
}
