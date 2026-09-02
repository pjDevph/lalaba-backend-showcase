import { Injectable, Scope } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import DataLoader from 'dataloader';
import { Role, RoleDocument } from './schemas/role.schema';

// Batches Role lookups for a single request so resolving the `role` field over
// a list of users (e.g. myStaff/listUsers, which return lean docs without a
// populated role) is ONE query instead of one per user — mirrors the
// transactions loader pattern. Request-scoped so batching is per-request.
@Injectable({ scope: Scope.REQUEST })
export class RoleLoader {
  private readonly loader: DataLoader<string, Role | null>;

  constructor(
    @InjectModel(Role.name) private readonly roleModel: Model<RoleDocument>,
  ) {
    this.loader = new DataLoader<string, Role | null>(
      async (roleIds) => {
        const roles = await this.roleModel
          .find({ _id: { $in: [...roleIds] } } as any)
          .exec();
        const byId = new Map(roles.map((r) => [r._id.toString(), r]));
        return roleIds.map((id) => byId.get(id) ?? null);
      },
      { cache: false },
    );
  }

  load(roleId: string): Promise<Role | null> {
    return this.loader.load(roleId);
  }
}
