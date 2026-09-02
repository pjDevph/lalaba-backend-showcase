import { SetMetadata } from '@nestjs/common';

// GqlAuthGuard refuses any user with isActive=false. An account inside its
// deletion grace period is exactly that — but it must still be able to reach
// the ONE operation that undoes the request, otherwise "cancel any time during
// the grace period" is not actually self-service. Handlers marked with this
// decorator are the only ones a DELETION_PENDING account may call.
export const ALLOW_DELETION_PENDING = 'allowDeletionPending';
export const AllowDeletionPending = () =>
  SetMetadata(ALLOW_DELETION_PENDING, true);
