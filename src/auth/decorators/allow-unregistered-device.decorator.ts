import { SetMetadata } from '@nestjs/common';

// Marks a resolver/handler as callable by a STAFF user whose device is not yet
// registered/approved. The GqlAuthGuard still verifies the Firebase token and
// that the caller is a valid staff with a merchantId — it only skips the
// "device must be approved" check. Use ONLY on the registration/approval-status
// path (registerDevice, myDevice, myBranchOptions).
export const ALLOW_UNREGISTERED_DEVICE = 'allowUnregisteredDevice';
export const AllowUnregisteredDevice = () =>
  SetMetadata(ALLOW_UNREGISTERED_DEVICE, true);
