import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { MaintenanceApp, MaintenanceService } from './maintenance.service';
import { MaintenanceConfig } from './schemas/maintenance-config.schema';
import { UpdateMaintenanceConfigInput } from './dto/maintenance.input';
import { MaintenanceStatus } from './models/maintenance-status.model';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AllowDuringMaintenance } from '../auth/decorators/allow-during-maintenance.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';

@Resolver()
@UseGuards(GqlAuthGuard, RolesGuard)
export class MaintenanceResolver {
  constructor(private readonly maintenance: MaintenanceService) {}

  // Admin's own config screen needs the raw settings (including the other
  // app's state and the bypass list) — support can view but not edit, same
  // split as every other kill-switch-grade mutation in this codebase.
  @Roles('admin', 'support')
  @Query(() => MaintenanceConfig, { name: 'maintenanceConfig' })
  async maintenanceConfig(): Promise<MaintenanceConfig> {
    return this.maintenance.current();
  }

  @Roles('admin')
  @Mutation(() => MaintenanceConfig, { name: 'updateMaintenanceConfig' })
  async updateMaintenanceConfig(
    @Args('input') input: UpdateMaintenanceConfigInput,
  ): Promise<MaintenanceConfig> {
    return this.maintenance.update(input);
  }

  // What every app-facing client actually polls — the caller's own effective
  // state, never the raw config. Exempt from the maintenance block itself:
  // a blocked app must still be able to ask "am I still blocked?".
  @Roles('customer', 'merchant', 'staff', 'washer', 'courier')
  @AllowDuringMaintenance()
  @Query(() => MaintenanceStatus, { name: 'maintenanceStatus' })
  async maintenanceStatus(
    @CurrentUser() user: User,
  ): Promise<MaintenanceStatus> {
    const roleId = (user.role as unknown as Role)?.roleId;
    return this.maintenance.effectiveStateForRole(roleId, user._id);
  }
}

/**
 * THE COLD-START CHECK, BEFORE ANYONE HAS SIGNED IN.
 *
 * DELIBERATELY UNGUARDED — no GqlAuthGuard, so no token is required.
 *
 * Without it the only way to discover a platform-wide block is to hit it:
 * open the app, type a phone number, wait for an SMS, authenticate, and only
 * then be told nothing works. That costs the person an OTP and reads like a
 * failed login rather than a planned outage. An anonymous client has no
 * identity to derive an app from, so it names its own surface.
 *
 * The payload is the same public-safe MaintenanceStatus every blocked user is
 * already shown: blocked, type, message, when it ends, and where to get help.
 * It exposes no configuration, no bypass list, no other surface's settings and
 * nothing written for staff — an outage announces itself to anyone who opens
 * the app, so there is nothing here to withhold.
 *
 * NOT a replacement for anything. The authenticated `maintenanceStatus` poll
 * and the MAINTENANCE_MODE error extensions both stay exactly as they were;
 * this covers the one moment neither can, and only for a client that has no
 * session. A signed-in client keeps using the authenticated query, which is
 * the one that honours bypassUids — an anonymous caller has no uid to exempt.
 */
@Resolver()
export class PublicMaintenanceResolver {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Query(() => MaintenanceStatus, { name: 'publicMaintenanceStatus' })
  async publicMaintenanceStatus(
    @Args('app', { type: () => MaintenanceApp }) app: MaintenanceApp,
  ): Promise<MaintenanceStatus> {
    return this.maintenance.publicStateForApp(app);
  }
}
