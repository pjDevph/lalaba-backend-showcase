import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CostingService } from './costing.service';
import { CostingResolver } from './costing.resolver';
import {
  CostingConfig,
  CostingConfigSchema,
} from './schemas/costing-config.schema';
import {
  CostingReport,
  CostingReportSchema,
} from './schemas/costing-report.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import {
  Permission,
  PermissionSchema,
} from '../permissions/schemas/permission.schema';
import { UsersModule } from '../users/users.module';
import { DevicesModule } from '../devices/devices.module';
import { PermissionsGuard } from '../auth/guards/permissions.guard';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CostingConfig.name, schema: CostingConfigSchema },
      { name: CostingReport.name, schema: CostingReportSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: Permission.name, schema: PermissionSchema },
    ]),
    UsersModule,
    DevicesModule,
  ],
  providers: [CostingService, CostingResolver, PermissionsGuard],
  exports: [CostingService],
})
export class CostingModule {}
