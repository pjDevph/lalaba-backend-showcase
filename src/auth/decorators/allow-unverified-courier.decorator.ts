import { SetMetadata } from '@nestjs/common';

// Marks a resolver/handler as callable by a COURIER who has not yet passed the
// liveness selfie check. GqlAuthGuard still verifies the Firebase token and that
// the account is active — it only skips the "selfie must be ACTIVE" gate.
//
// Use ONLY on the bootstrap path. A courier who cannot reach
// submitCourierSelfie/myCourierSelfie can never open their own gate, so
// forgetting this decorator on those two locks every courier out permanently.
// The device path (myDevice/claimDevice) needs it for the same reason: a courier
// blocked there cannot get far enough to submit a selfie.
export const ALLOW_UNVERIFIED_COURIER = 'allowUnverifiedCourier';
export const AllowUnverifiedCourier = () =>
  SetMetadata(ALLOW_UNVERIFIED_COURIER, true);
