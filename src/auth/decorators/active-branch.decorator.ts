import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

/**
 * The branch the caller is currently working, or null.
 *
 * Set by GqlAuthGuard from the staff member's approved device. Null for owners
 * and washers, who are not device-pinned and may act on any branch they own —
 * so a null here means "unrestricted", not "denied", and each call site says
 * which it means.
 */
export const ActiveBranch = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | null =>
    GqlExecutionContext.create(context).getContext().req?.activeBranchId ??
    null,
);
