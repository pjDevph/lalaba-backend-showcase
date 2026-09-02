// Role-default permission floor for individually-authenticated staff.
//
// The app treats role defaults as a fallback: a staff member keeps the
// capabilities their role grants by default without an owner having to tick
// them, and explicit grants only ADD to that floor. The backend guard enforces
// on `permissionIds` alone, so to keep FE and BE in agreement these default
// names are allowed for staff even when absent from their grant list.
//
// This mirrors ROLE_DEFAULTS.STAFF (=== true) in the merchant app
// (src/types/permissions.ts), limited to the BE-enforced permission names.
// The backend can't distinguish a MANAGER branch-role from a plain STAFF for an
// individually-authenticated account, so the conservative STAFF floor is used
// for all staff; manager-only defaults (e.g. order_cancel) still require an
// explicit grant. Keep this in sync with the app's STAFF role defaults.
export const STAFF_DEFAULT_PERMISSION_NAMES: readonly string[] = [
  'order_confirm_pickup', // canConfirmPickup
  'order_update_status', // canUpdateOrderStatus
  'inventory_edit', // canEditInventory
];

/**
 * SEC-009 — the owner (merchant) permission floor.
 *
 * PermissionsGuard used to short-circuit with `if (role?.roleId === 'merchant')
 * return true`, a blanket bypass of EVERY @RequirePermissions decorator: any
 * permission gate added anywhere in the codebase was, silently and forever,
 * unenforced for owner accounts. That is a bypass, not a policy — nothing
 * recorded which capabilities an owner was actually meant to hold.
 *
 * This list makes it explicit. An owner satisfies a permission check only when
 * EVERY required permission appears here; anything else falls through to the
 * normal explicit-grant lookup. Owner accounts carry no permissionIds, so this
 * floor is what keeps them working — it deliberately enumerates the whole
 * business catalogue, because an owner does own their whole business.
 *
 * The point of writing it out is drift: a permission added to
 * PERMISSION_CATALOGUE and to a resolver but NOT added here fails CLOSED for
 * owners instead of silently passing. `permissions-guard.spec.ts` asserts this
 * list covers the catalogue, so that omission surfaces in CI rather than in
 * production.
 */
export const OWNER_DEFAULT_PERMISSION_NAMES: readonly string[] = [
  // POS & Orders
  'order_create',
  'order_apply_discount',
  'order_cancel',
  'order_confirm_pickup',
  'order_update_status',
  // Services
  'service_create',
  'service_edit',
  'service_archive',
  // Reports & Logs
  'report_view',
  'report_export',
  'log_view',
  // Costing
  'costing_read',
  'costing_create',
  'costing_update',
  // Inventory
  'inventory_create',
  'inventory_edit',
  'inventory_archive',
  // Products
  'product_create',
  'product_update',
  'product_archive',
];
