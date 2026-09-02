import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Model } from 'mongoose';
import {
  Permission,
  PermissionDocument,
} from '../../permissions/schemas/permission.schema';
import { Role } from '../../users/schemas/role.schema';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { OWNER_DEFAULT_PERMISSION_NAMES } from '../../permissions/role-defaults';
import {
  holdsOnBranch,
  predatesBranchAccess,
} from '../../permissions/branch-permission-check';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectModel(Permission.name)
    private readonly permissionModel: Model<PermissionDocument>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredPermissions?.length) return true;

    const ctx = GqlExecutionContext.create(context);
    const req = ctx.getContext().req;
    const user = req.user;
    const role = user?.role as unknown as Role;

    const DENIED = 'You do not have permission to perform this action.';

    // SEC-009 — owner floor, no longer a blanket bypass.
    //
    // This was `if (role?.roleId === 'merchant') return true`, which exempted
    // owner accounts from every @RequirePermissions gate in the codebase,
    // present and future, with no record of what an owner was meant to hold.
    // Owners still pass the business catalogue (they own the business and
    // carry no permissionIds of their own), but only for permissions
    // explicitly enumerated in OWNER_DEFAULT_PERMISSION_NAMES, and only when
    // the floor covers ALL of them. A new gate that is not on that list falls
    // through and fails closed.
    //
    // Owners are not branch-scoped: they may act on every branch they own, so
    // no active branch is required or consulted here.
    if (
      role?.roleId === 'merchant' &&
      requiredPermissions.every((p) =>
        OWNER_DEFAULT_PERMISSION_NAMES.includes(p),
      )
    ) {
      return true;
    }

    if (role?.roleId === 'staff') {
      // ROLLOUT SHIM — remove one release after the backfill. See
      // predatesBranchAccess for why a cached pre-migration document must not
      // be denied.
      if (predatesBranchAccess(user)) {
        const matched = await this.permissionModel
          .findOne({
            _id: { $in: user.permissionIds ?? [] },
            permissionName: { $in: requiredPermissions },
          })
          .lean()
          .exec();
        if (!matched) throw new ForbiddenException(DENIED);
        return true;
      }

      // The branch a staff member is working is decided by their approved
      // device, resolved in GqlAuthGuard. Its absence means the device gate did
      // not run for this handler, and a handler that skips the device gate has
      // no business consulting permissions — fail closed rather than guess a
      // branch.
      const activeBranchId = req.activeBranchId
        ? String(req.activeBranchId)
        : null;
      if (!activeBranchId) {
        throw new ForbiddenException(
          'Your device is not assigned to a branch. Ask your manager to approve it again.',
        );
      }

      // Note there is no longer a staff role floor. It used to grant
      // order_confirm_pickup, order_update_status and inventory_edit
      // unconditionally, which made a permission toggle that claimed to be off
      // partly on. Every grant is now explicit, and the backfill migration gave
      // existing staff those three permissions for real.
      const holds = await holdsOnBranch(
        this.permissionModel,
        user,
        activeBranchId,
        requiredPermissions,
      );
      if (!holds) throw new ForbiddenException(DENIED);
      return true;
    }

    // Washer, courier, customer, admin and support hold no per-branch grants:
    // their capabilities are decided by @Roles, not by this catalogue. Reaching
    // here means a gated resolver was called by a role that has no way to pass,
    // which is a denial rather than an oversight to paper over.
    throw new ForbiddenException(DENIED);
  }
}
