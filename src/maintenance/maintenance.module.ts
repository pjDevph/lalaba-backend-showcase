import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MaintenanceService } from './maintenance.service';
import {
  MaintenanceResolver,
  PublicMaintenanceResolver,
} from './maintenance.resolver';
import {
  MaintenanceConfig,
  MaintenanceConfigSchema,
} from './schemas/maintenance-config.schema';

// @Global, mirroring FirebaseModule: GqlAuthGuard is instantiated directly
// (via @UseGuards(GqlAuthGuard, ...)) inside 38+ feature modules that share
// no common parent module, and it needs MaintenanceService to check every
// request against the current maintenance state. Without @Global, every one
// of those modules would need to import MaintenanceModule individually.
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MaintenanceConfig.name, schema: MaintenanceConfigSchema },
    ]),
  ],
  providers: [
    MaintenanceService,
    MaintenanceResolver,
    PublicMaintenanceResolver,
  ],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
