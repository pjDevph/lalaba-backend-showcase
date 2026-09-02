import {
  ObjectType,
  Field,
  ID,
  Int,
  GraphQLISODateTime,
} from '@nestjs/graphql';
import { NotificationCategory, NotificationType } from '../notification.enums';
import { NotificationData } from '../schemas/notification.schema';

/**
 * One notification, as a specific account sees it.
 *
 * Distinct from the Notification document because `isRead` is not a property of
 * the notification — a branch row is read by one colleague and unread by
 * another at the same instant. It is computed per caller and must never become
 * a stored column.
 *
 * `audience`, `merchantId`, `readAt` and `pushSentAt` are deliberately not
 * exposed: they are addressing and observability internals, and a client that
 * branches on them would be reimplementing visibility rules the server already
 * applied.
 */
@ObjectType()
export class NotificationItem {
  @Field(() => ID) id!: string;

  @Field(() => NotificationType) type!: NotificationType;

  @Field(() => NotificationCategory) category!: NotificationCategory;

  @Field() title!: string;

  @Field() body!: string;

  @Field(() => NotificationData) data!: NotificationData;

  @Field(() => String, { nullable: true }) deepLink?: string | null;

  @Field(() => String, { nullable: true }) branchId?: string | null;

  /**
   * Exposed so the partner app can re-filter for a shared-terminal shift.
   *
   * The server filters for the AUTHENTICATED identity. On a shared terminal
   * that identity is the branch owner, while the person actually holding the
   * device is a staff member the backend has no knowledge of — activeStaff and
   * effectivePermissions live only in the app's stores. Without this field the
   * client could not narrow the list to what the acting staff may see.
   */
  @Field(() => String, { nullable: true })
  requiredPermission?: string | null;

  /** Computed for the calling account. Never a stored column — see above. */
  @Field() isRead!: boolean;

  @Field(() => GraphQLISODateTime) createdAt!: Date;
}

/**
 * Standard page envelope, matching PaginatedOnlineOrders and the other
 * Paginated* types so the apps can share their paging code.
 */
@ObjectType()
export class PaginatedNotifications {
  @Field(() => [NotificationItem]) data!: NotificationItem[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}
