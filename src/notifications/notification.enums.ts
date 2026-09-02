import { registerEnumType } from '@nestjs/graphql';

/**
 * Who a notification is addressed to.
 *
 * A discriminator rather than "whichever of uid/branchId is set", because every
 * feed query branches on it and a partial index needs something unambiguous to
 * key on.
 */
export enum NotificationAudience {
  /** One account. `uid` set, `branchId` null. */
  USER = 'USER',
  /**
   * Everyone working a branch. ONE row, read independently by each member —
   * see notification-read.schema.ts for why read state cannot live inline.
   */
  BRANCH = 'BRANCH',
}
registerEnumType(NotificationAudience, { name: 'NotificationAudience' });

/** Coarse grouping — drives the row icon and colour, and nothing else. */
export enum NotificationCategory {
  ORDER = 'ORDER',
  ACCOUNT = 'ACCOUNT',
  VERIFICATION = 'VERIFICATION',
  DEVICE = 'DEVICE',
  STAFF = 'STAFF',
  BROADCAST = 'BROADCAST',
  SYSTEM = 'SYSTEM',
}
registerEnumType(NotificationCategory, { name: 'NotificationCategory' });

/**
 * What happened. Kept deliberately coarse: `ORDER_STATUS` carries the specific
 * status in `data.status` rather than exploding into ~25 members, so adding an
 * order status never requires a schema migration.
 *
 * The KYC, DEVICE and STAFF values match the `data.type` strings the existing
 * push senders already emit, so the clients' tap handlers keep working
 * unchanged through the migration.
 */
export enum NotificationType {
  // Migrated from the existing fire-and-forget push senders.
  KYC_APPROVED = 'KYC_APPROVED',
  KYC_REJECTED = 'KYC_REJECTED',
  KYC_CASE_ACTION_NEEDED = 'KYC_CASE_ACTION_NEEDED',
  DEVICE_REGISTRATION = 'DEVICE_REGISTRATION',
  STAFF_LOGIN = 'STAFF_LOGIN',
  BROADCAST = 'BROADCAST',
  // New.
  ORDER_STATUS = 'ORDER_STATUS',
  /**
   * An order state the recipient must act on to unblock (quality hold, return
   * selection, a proposed change). Split from ORDER_STATUS so the client can
   * style and sort it as urgent without knowing the status table.
   */
  ORDER_ACTION_NEEDED = 'ORDER_ACTION_NEEDED',
}
registerEnumType(NotificationType, { name: 'NotificationType' });
