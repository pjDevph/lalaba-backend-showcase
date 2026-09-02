// Canonical permission catalogue — the single source of truth for every
// permission the system references. `PermissionsService.onModuleInit` upserts
// these into the `permissions` collection on boot so the catalogue can never
// drift from the code.
//
// IMPORTANT: `permissionName` values must stay in lockstep with:
//   • the `@RequirePermissions(...)` decorators in the backend resolvers, and
//   • `FE_TO_BE_PERMISSIONS` in the merchant app (src/types/permissions.ts).
// A name here that no resolver enforces is FE-gated only; a name a resolver
// requires but that is absent here would be un-grantable — keep all three in sync.

export interface PermissionSeed {
  permissionName: string;
  description: string;
}

export const PERMISSION_CATALOGUE: PermissionSeed[] = [
  // ── POS & Orders ──────────────────────────────────────────────────────────
  { permissionName: 'order_create', description: 'Create new POS orders.' },
  {
    permissionName: 'order_apply_discount',
    description: 'Apply discounts when creating orders.',
  },
  {
    permissionName: 'order_cancel',
    description: 'Cancel orders (unpaid or paid).',
  },
  {
    permissionName: 'order_confirm_pickup',
    description: 'Confirm pickup and process payment.',
  },
  {
    permissionName: 'order_update_status',
    description: 'Move orders through processing statuses.',
  },
  // ── Services ──────────────────────────────────────────────────────────────
  {
    permissionName: 'service_create',
    description: 'Create new laundry services.',
  },
  { permissionName: 'service_edit', description: 'Edit existing services.' },
  {
    permissionName: 'service_archive',
    description: 'Archive or restore services.',
  },
  // ── Reports & Logs ────────────────────────────────────────────────────────
  {
    permissionName: 'report_view',
    description: 'View sales and analytics reports.',
  },
  {
    permissionName: 'report_export',
    description: 'Export or download reports.',
  },
  { permissionName: 'log_view', description: 'View staff activity logs.' },
  // ── Costing ───────────────────────────────────────────────────────────────
  {
    permissionName: 'costing_read',
    description: 'View costing and profit figures.',
  },
  {
    permissionName: 'costing_create',
    description: 'Create and save daily costing entries.',
  },
  {
    permissionName: 'costing_update',
    description: 'Edit saved costing entries.',
  },
  // ── Inventory ─────────────────────────────────────────────────────────────
  {
    permissionName: 'inventory_create',
    description: 'Add new inventory items.',
  },
  {
    permissionName: 'inventory_edit',
    description: 'Edit or restock inventory items.',
  },
  {
    permissionName: 'inventory_archive',
    description: 'Archive or restore inventory items.',
  },
  // ── Products ──────────────────────────────────────────────────────────────
  {
    permissionName: 'product_create',
    description: 'Add new sellable products.',
  },
  { permissionName: 'product_update', description: 'Edit sellable products.' },
  {
    permissionName: 'product_archive',
    description: 'Archive or restore sellable products.',
  },
];
