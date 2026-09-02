import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AccountDeletionService } from './account-deletion.service';

// Nightly grace-period sweep. Like the quality-hold sweep (Agent 4) this runs
// in-process on every instance with no distributed lock — safe because
// eraseAccount only ever selects DELETION_PENDING users and leaves them
// DELETED, so a concurrent second sweep finds nothing to do.
@Injectable()
export class AccountDeletionScheduler {
  private readonly logger = new Logger(AccountDeletionScheduler.name);

  constructor(private readonly service: AccountDeletionService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async sweepExpiredGracePeriods(): Promise<void> {
    const { processed, failed } =
      await this.service.processScheduledDeletions();
    if (processed > 0 || failed > 0) {
      this.logger.log(
        `Account-deletion sweep: ${processed} erased, ${failed} failed`,
      );
    }
  }
}
