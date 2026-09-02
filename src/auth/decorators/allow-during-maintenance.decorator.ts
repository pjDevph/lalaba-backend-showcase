import { SetMetadata } from '@nestjs/common';

// GqlAuthGuard blocks every request from an app currently in maintenance
// (see MaintenanceService.effectiveStateForRole). The one operation that must
// stay reachable is the status check the maintenance screen itself polls —
// otherwise a blocked app could never learn the maintenance has ended.
export const ALLOW_DURING_MAINTENANCE = 'allowDuringMaintenance';
export const AllowDuringMaintenance = () =>
  SetMetadata(ALLOW_DURING_MAINTENANCE, true);
