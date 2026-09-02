// src/branches/branches.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BranchesService } from './branches.service';
import { BranchesResolver } from './branches.resolver';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Branch, BranchSchema } from './schemas/branch.schema';
import { FirebaseModule } from '../firebase/firebase.module';
import { UsersModule } from '../users/users.module';
import { DevicesModule } from '../devices/devices.module';
import { WalletsModule } from '../wallets/wallets.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Branch.name, schema: BranchSchema }]),
    FirebaseModule,
    UsersModule,
    DevicesModule,
    WalletsModule,
  ],
  providers: [BranchesService, BranchesResolver, RolesGuard],
})
export class BranchesModule {}
