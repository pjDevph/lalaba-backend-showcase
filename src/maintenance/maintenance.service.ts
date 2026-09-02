import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Model } from 'mongoose';
import { registerEnumType } from '@nestjs/graphql';
import {
  MaintenanceConfig,
  MaintenanceConfigDocument,
  MaintenanceType,
} from './schemas/maintenance-config.schema';
import { UpdateMaintenanceConfigInput } from './dto/maintenance.input';
import { MaintenanceStatus } from './models/maintenance-status.model';

const SINGLETON_ID = 'singleton';
const CACHE_KEY = 'maintenance-config';
// Short TTL, not "until invalidated": GqlAuthGuard reads this on every
// request via effectiveStateForRole, so it must stay cheap, but an
// out-of-band DB edit (a script, a second admin instance) should still take
// effect within a few seconds rather than never.
const CACHE_TTL_MS = 15 * 1000;

// Which app a role belongs to for maintenance purposes. Two customer-facing
// codebases exist today: the pure customer app, and the shared
// merchant/staff/washer/courier "partner" app — so those four roles all map
// to the same partnerApp state. admin/support are never blocked (they need
// the admin panel itself to manage this).
const PARTNER_APP_ROLES = new Set(['merchant', 'staff', 'washer', 'courier']);

/**
 * Which surface is asking, when nobody is signed in to ask on behalf of.
 *
 * Authenticated callers never send this — their app is derived from their
 * role, which cannot be spoofed. It exists only for the cold-start check an
 * anonymous client makes before there is any identity to derive from.
 */
export enum MaintenanceApp {
  CUSTOMER = 'CUSTOMER',
  PARTNER = 'PARTNER',
}
registerEnumType(MaintenanceApp, { name: 'MaintenanceApp' });

const DEFAULT_APP_STATE = { active: false, mode: MaintenanceType.EMERGENCY };

@Injectable()
export class MaintenanceService {
  constructor(
    @InjectModel(MaintenanceConfig.name)
    private readonly configModel: Model<MaintenanceConfigDocument>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async current(): Promise<MaintenanceConfig> {
    const cached = await this.cache.get<MaintenanceConfig>(CACHE_KEY);
    if (cached) return cached;

    const doc = await this.configModel
      .findByIdAndUpdate(
        SINGLETON_ID,
        {
          $setOnInsert: {
            globalEmergencyActive: false,
            supportEmail: null,
            supportPhone: null,
            customerApp: DEFAULT_APP_STATE,
            partnerApp: DEFAULT_APP_STATE,
            bypassUids: [],
          },
        },
        { upsert: true, new: true },
      )
      .exec();

    await this.cache.set(CACHE_KEY, doc, CACHE_TTL_MS);
    return doc;
  }

  // ADMIN-ONLY (enforced by the resolver's @Roles('admin')): replace the
  // whole config in one write — there's no partial-patch semantics here, the
  // admin panel always sends the full form state back.
  async update(
    input: UpdateMaintenanceConfigInput,
  ): Promise<MaintenanceConfig> {
    this.assertReachableWhileBlocked(input);
    const doc = await this.configModel
      .findByIdAndUpdate(
        SINGLETON_ID,
        {
          $set: {
            globalEmergencyActive: input.globalEmergencyActive,
            globalEmergencyMessage: input.globalEmergencyMessage ?? null,
            customerApp: {
              active: input.customerApp.active,
              mode: input.customerApp.mode,
              message: input.customerApp.message ?? null,
              scheduledStart: input.customerApp.scheduledStart
                ? new Date(input.customerApp.scheduledStart)
                : null,
              scheduledEnd: input.customerApp.scheduledEnd
                ? new Date(input.customerApp.scheduledEnd)
                : null,
            },
            partnerApp: {
              active: input.partnerApp.active,
              mode: input.partnerApp.mode,
              message: input.partnerApp.message ?? null,
              scheduledStart: input.partnerApp.scheduledStart
                ? new Date(input.partnerApp.scheduledStart)
                : null,
              scheduledEnd: input.partnerApp.scheduledEnd
                ? new Date(input.partnerApp.scheduledEnd)
                : null,
            },
            supportEmail: input.supportEmail?.trim() || null,
            supportPhone: input.supportPhone?.trim() || null,
            bypassUids: input.bypassUids,
          },
        },
        { upsert: true, new: true },
      )
      .exec();

    await this.cache.del(CACHE_KEY);
    return doc;
  }

  /**
   * A block must always leave people somewhere to turn.
   *
   * Stated as an invariant over the RESULTING config, not as a rule about the
   * transition that produced it. "Requiring a contact when switching a block
   * on" leaves the obvious hole open: block first, clear the contacts after,
   * and the guarantee is gone with nothing having been refused. Checked on
   * every write, so the only way to have no support contact is to have nothing
   * blocked.
   *
   * Enforced here and not only in the admin panel because the panel is one
   * client of this mutation, and the invariant belongs to the data.
   */
  private assertReachableWhileBlocked(
    input: UpdateMaintenanceConfigInput,
  ): void {
    const blocking =
      input.globalEmergencyActive ||
      input.customerApp.active ||
      input.partnerApp.active;
    if (!blocking) return;

    if (!input.supportEmail?.trim() && !input.supportPhone?.trim()) {
      throw new BadRequestException(
        'A support email or phone number is required while any maintenance block is active — it is the only thing a blocked person can reach.',
      );
    }
  }

  /**
   * The cold-start answer for a client with no session yet.
   *
   * Same rules and the same public-safe payload as `effectiveStateForRole`,
   * minus the two things that need an identity: the bypass list (an anonymous
   * caller has no uid to be exempt) and role derivation (hence the explicit
   * app). Deliberately returns nothing beyond what a blocked person is shown
   * anyway — no config, no bypass uids, no other surface's settings.
   */
  async publicStateForApp(app: MaintenanceApp): Promise<MaintenanceStatus> {
    const roleId = app === MaintenanceApp.CUSTOMER ? 'customer' : 'merchant';
    // '' is not a bypass uid, and cannot be: bypassUids entries are Firebase
    // uids, and the admin panel filters empty lines out on the way in.
    return this.effectiveStateForRole(roleId, '');
  }

  /**
   * The single source of truth both GqlAuthGuard and the `maintenanceStatus`
   * query call. Returns "not blocked" for admin/support, a bypassed uid, an
   * inactive app state, or a SCHEDULED window that hasn't started/already
   * ended.
   */
  async effectiveStateForRole(
    roleId: string | undefined,
    uid: string,
  ): Promise<MaintenanceStatus> {
    // Support contact rides along on every answer, blocked or not. Reading it
    // needs the config, and admin/support bail out before that — they are
    // never blocked, so they never need somewhere to turn.
    const bare: MaintenanceStatus = {
      blocked: false,
      type: null,
      message: null,
      endsAt: null,
    };

    if (!roleId || roleId === 'admin' || roleId === 'support') return bare;

    const config = await this.current();
    const support = {
      supportEmail: config.supportEmail ?? null,
      supportPhone: config.supportPhone ?? null,
    };
    const notBlocked: MaintenanceStatus = { ...bare, ...support };

    if (config.bypassUids.includes(uid)) return notBlocked;

    if (config.globalEmergencyActive) {
      return {
        blocked: true,
        type: MaintenanceType.EMERGENCY,
        message:
          config.globalEmergencyMessage ??
          'The platform is temporarily unavailable. Please try again shortly.',
        endsAt: null,
        ...support,
      };
    }

    const appState =
      roleId === 'customer'
        ? config.customerApp
        : PARTNER_APP_ROLES.has(roleId)
          ? config.partnerApp
          : null;
    if (!appState?.active) return notBlocked;

    if (appState.mode === MaintenanceType.EMERGENCY) {
      return {
        blocked: true,
        type: MaintenanceType.EMERGENCY,
        message: appState.message ?? 'This app is temporarily unavailable.',
        endsAt: null,
        ...support,
      };
    }

    // SCHEDULED — only blocking inside its own window.
    const now = new Date();
    const inWindow =
      appState.scheduledStart != null &&
      appState.scheduledEnd != null &&
      now >= appState.scheduledStart &&
      now <= appState.scheduledEnd;
    if (!inWindow) return notBlocked;

    return {
      blocked: true,
      type: MaintenanceType.SCHEDULED,
      message: appState.message ?? 'Scheduled maintenance is in progress.',
      endsAt: appState.scheduledEnd,
      ...support,
    };
  }
}
