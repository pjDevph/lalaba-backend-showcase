import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TasksService } from './tasks.service';
import { TasksResolver } from './tasks.resolver';
import { Task, TaskSchema } from './schemas/task.schema';
import { UsersModule } from '../users/users.module';
import { DevicesModule } from '../devices/devices.module';
import { RolesGuard } from '../auth/guards/roles.guard';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Task.name, schema: TaskSchema }]),
    UsersModule,
    DevicesModule,
  ],
  providers: [TasksService, TasksResolver, RolesGuard],
  exports: [TasksService],
})
export class TasksModule {}
