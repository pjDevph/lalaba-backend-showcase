import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AdminAuditService } from './admin-audit.service';
import { AdminAuditResolver } from './admin-audit.resolver';
import {
  AdminAuditEvent,
  AdminAuditEventSchema,
} from './schemas/admin-audit-event.schema';

/**
 * @Global because almost every admin-facing module needs to record into the
 * trail, and threading an import through each of them is exactly the friction
 * that leads to "I'll add the audit call later" — which is how the platform
 * ended up with audit coverage in the KYC module and nowhere else.
 */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AdminAuditEvent.name, schema: AdminAuditEventSchema },
    ]),
  ],
  providers: [AdminAuditService, AdminAuditResolver],
  exports: [AdminAuditService],
})
export class AdminAuditModule {}
