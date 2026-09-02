// Owner-facing permission groups.
//
// Merchants do not think in terms of `order_apply_discount` or
// `product_archive`; they think "can this person work the counter?". The staff
// UI therefore offers four broad switches per branch, and this file is the one
// place that says which catalogue entries each switch grants.
//
// IMPORTANT: the four groups must PARTITION `PERMISSION_CATALOGUE` — every
// permission belongs to exactly one group. A catalogue entry left out of this
// map would be un-grantable through the app, and one listed twice would make
// `groupsFromNames` ambiguous. `permission-groups.spec.ts` asserts both, so a
// new permission added to the catalogue fails the suite until it is filed here.

import { registerEnumType } from '@nestjs/graphql';

export enum PermissionGroup {
  ORDERS = 'ORDERS',
  INVENTORY = 'INVENTORY',
  SERVICES = 'SERVICES',
  OTHERS = 'OTHERS',
}

registerEnumType(PermissionGroup, {
  name: 'PermissionGroup',
  description:
    'A broad, owner-facing bundle of permissions granted per branch. Expanded to individual permission names server-side.',
});

export const PERMISSION_GROUP_MEMBERS: Record<
  PermissionGroup,
  readonly string[]
> = {
  // Everything the counter does, including the money-sensitive parts. Discounts
  // and cancellations live here deliberately rather than as a separate switch:
  // a fifth toggle re-creates the matrix this design exists to remove. The
  // financial control is the audit trail on the action, not a hidden checkbox.
  [PermissionGroup.ORDERS]: [
    'order_create',
    'order_apply_discount',
    'order_cancel',
    'order_confirm_pickup',
    'order_update_status',
  ],
  // Raw stock (detergent, fabcon) and sellable retail products are separate
  // permission families on the backend but one question to an owner: may this
  // person touch what is on the shelves?
  [PermissionGroup.INVENTORY]: [
    'inventory_create',
    'inventory_edit',
    'inventory_archive',
    'product_create',
    'product_update',
    'product_archive',
  ],
  [PermissionGroup.SERVICES]: [
    'service_create',
    'service_edit',
    'service_archive',
  ],
  // Reporting, audit logs and costing. Costing is still behind a feature flag
  // in the app, so granting it today is inert — but it is filed here rather
  // than omitted so the partition stays total and the group needs no edit when
  // Phase 2 lands.
  [PermissionGroup.OTHERS]: [
    'report_view',
    'report_export',
    'log_view',
    'costing_read',
    'costing_create',
    'costing_update',
  ],
};

export const ALL_PERMISSION_GROUPS: readonly PermissionGroup[] =
  Object.values(PermissionGroup);

/** The permission names granted by a set of groups. Order is not significant. */
export function expandGroups(
  groups: readonly PermissionGroup[] | undefined | null,
): string[] {
  if (!groups?.length) return [];
  const names = new Set<string>();
  for (const group of groups) {
    for (const name of PERMISSION_GROUP_MEMBERS[group] ?? []) names.add(name);
  }
  return [...names];
}

/**
 * Which groups a set of permission names represents.
 *
 * ANY member switches its group on, because that is the only answer a
 * four-switch UI can render. A partial holding — `order_confirm_pickup` without
 * `order_cancel`, which is exactly what the old implicit staff floor produced —
 * therefore reads back as a full ORDERS group. That is why the backfill
 * migration expands groups as it writes: the stored grant is made to match what
 * the UI claims, rather than the UI quietly overstating the grant.
 */
export function groupsFromNames(
  names: readonly string[] | undefined | null,
): PermissionGroup[] {
  if (!names?.length) return [];
  const held = new Set(names);
  return ALL_PERMISSION_GROUPS.filter((group) =>
    PERMISSION_GROUP_MEMBERS[group].some((name) => held.has(name)),
  );
}
