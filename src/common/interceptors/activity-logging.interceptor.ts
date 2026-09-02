import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { GraphQLResolveInfo } from 'graphql';
import { ActivityLogsService } from '../../activity-logs/activity-logs.service';
import { ActivityStatus } from '../../activity-logs/schemas/activity-log.schema';
import { User } from '../../users/schemas/user.schema';
import { Role } from '../../users/schemas/role.schema';

const RESOLVER_MODULE_MAP = new Map<string, string>([
  ['PosOrdersResolver', 'pos_orders'],
  ['TasksResolver', 'tasks'],
  ['StaffResolver', 'staff'],
  ['InventoryResolver', 'inventory'],
  ['ProductsResolver', 'products'],
  ['ServicesResolver', 'services'],
  ['BranchesResolver', 'branches'],
  ['UsersResolver', 'users'],
  ['AnalyticsResolver', 'analytics'],
  ['PosTransactionsResolver', 'pos_transactions'],
  ['DevicesResolver', 'devices'],
  ['PermissionsResolver', 'permissions'],
  ['RolesResolver', 'roles'],
]);

const SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'secret',
  'fcmToken',
  'idToken',
]);

// Priority-ordered list of fields that hold a human-readable display name on
// the various entities mutations return (Staff/User, Service, Branch,
// Inventory, Product, Task, Device, Permission, Role, PosOrder). Falls back
// through firstName+lastName for person-like entities.
const TARGET_NAME_FIELDS = [
  'productName',
  'serviceName',
  'branchName',
  'title',
  'deviceName',
  'permissionName',
  'roleName',
  'customerName',
  'claimCode',
];

function extractTargetName(result: any): string | undefined {
  const obj = Array.isArray(result) ? result[0] : result;
  if (!obj || typeof obj !== 'object') return undefined;
  for (const field of TARGET_NAME_FIELDS) {
    const value = obj[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const fullName = `${obj.firstName ?? ''} ${obj.lastName ?? ''}`.trim();
  return fullName || undefined;
}

function sanitizeArgs(args: Record<string, any>): Record<string, any> {
  function deepSanitize(value: any): any {
    if (value === null || value === undefined) return value;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    )
      return value;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(deepSanitize);
    if (typeof value === 'object') {
      const result: Record<string, any> = {};
      for (const [key, val] of Object.entries(value)) {
        if (!SENSITIVE_KEYS.has(key)) {
          result[key] = deepSanitize(val);
        }
      }
      return result;
    }
    return undefined;
  }
  return (deepSanitize(args) as Record<string, any>) ?? {};
}

@Injectable()
export class ActivityLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ActivityLoggingInterceptor.name);

  constructor(private readonly activityLogsService: ActivityLogsService) {}

  /**
   * Audit writes are deliberately fire-and-forget: a logging failure must never
   * fail the user's request. But they must not be SILENT either — an unhandled
   * rejection here loses the audit event with no trace. `void` states the intent
   * explicitly and `.catch` makes the loss visible in the application log.
   */
  private recordAudit(
    data: Parameters<ActivityLogsService['record']>[0],
  ): void {
    void this.activityLogsService.record(data).catch((err: unknown) => {
      this.logger.error(
        `Failed to write activity log for "${data.action}" (module: ${data.module}, actor: ${String(data.actorId)}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType<GqlContextType>() !== 'graphql') {
      return next.handle();
    }

    const gqlCtx = GqlExecutionContext.create(context);
    const info = gqlCtx.getInfo<GraphQLResolveInfo>();

    if (info?.operation?.operation !== 'mutation') {
      return next.handle();
    }

    const user: User | undefined = gqlCtx.getContext().req?.user;
    if (!user) {
      return next.handle();
    }

    const role = user.role as unknown as Role;
    const actorType = role?.roleId ?? 'unknown';
    const merchantId = actorType === 'staff' ? user.merchantId! : user._id;
    const actorName = `${user.firstName} ${user.lastName}`;
    const actorEmail = user.email;
    const action = info.fieldName;
    const resolverClassName = context.getClass()?.name ?? '';
    const module =
      RESOLVER_MODULE_MAP.get(resolverClassName) ??
      resolverClassName.toLowerCase();
    const metadata = JSON.stringify(
      sanitizeArgs(gqlCtx.getArgs<Record<string, any>>()),
    );

    return next.handle().pipe(
      tap({
        next: (result: any) => {
          this.recordAudit({
            actorId: user._id,
            actorName,
            actorEmail,
            actorType,
            merchantId,
            action,
            module,
            targetId: result?._id?.toString() ?? undefined,
            targetName: extractTargetName(result),
            metadata,
            status: ActivityStatus.SUCCESS,
          });
        },
        error: (err: any) => {
          this.recordAudit({
            actorId: user._id,
            actorName,
            actorEmail,
            actorType,
            merchantId,
            action,
            module,
            metadata,
            status: ActivityStatus.ERROR,
            errorMessage: err?.message ?? 'Unknown error',
          });
        },
      }),
    );
  }
}
