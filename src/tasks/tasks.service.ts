import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Task, TaskDocument } from './schemas/task.schema';
import { CreateTaskInput } from './dto/create-task.input';
import { UpdateTaskInput } from './dto/update-task.input';
import { TaskFilterInput } from './dto/task-filter.input';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';

@Injectable()
export class TasksService {
  constructor(
    @InjectModel(Task.name) private readonly taskModel: Model<TaskDocument>,
  ) {}

  private getMerchantId(user: User): string {
    const role = user.role as unknown as Role;
    return role?.roleId === 'staff' ? user.merchantId! : user._id;
  }

  async findAll(uid: string, filter?: TaskFilterInput): Promise<Task[]> {
    const query: Record<string, any> = { uid };

    if (filter?.branchId) {
      query.branchId = filter.branchId;
    }
    if (filter?.isCompleted !== undefined) {
      query.isCompleted = filter.isCompleted;
    }
    if (filter?.isVisibleToStaff !== undefined) {
      query.isVisibleToStaff = filter.isVisibleToStaff;
    }

    const safeLimit = Math.min(filter?.limit ?? 100, 500);
    const safeOffset = Math.max(filter?.offset ?? 0, 0);
    return this.taskModel
      .find(query)
      .sort({ order: 1, createdAt: -1, _id: 1 })
      .skip(safeOffset)
      .limit(safeLimit)
      .exec();
  }

  async create(input: CreateTaskInput, user: User): Promise<Task> {
    const uid = this.getMerchantId(user);
    const task = new this.taskModel({ ...input, uid });
    return task.save();
  }

  async update(
    id: string,
    uid: string,
    input: UpdateTaskInput,
    branchIds?: string[],
  ): Promise<Task> {
    const task = await this.taskModel
      .findOne({ _id: new Types.ObjectId(id), uid } as any)
      .exec();
    if (!task) throw new NotFoundException('Task not found');
    if (branchIds && task.branchId && !branchIds.includes(task.branchId)) {
      throw new ForbiddenException('You do not have access to this task');
    }
    const updated = await this.taskModel
      .findByIdAndUpdate(id, { $set: input }, { new: true })
      .exec();
    return updated!;
  }

  async delete(id: string, uid: string, branchIds?: string[]): Promise<Task> {
    const task = await this.taskModel
      .findOne({ _id: new Types.ObjectId(id), uid } as any)
      .exec();
    if (!task) throw new NotFoundException('Task not found');
    if (branchIds && task.branchId && !branchIds.includes(task.branchId)) {
      throw new ForbiddenException('You do not have access to this task');
    }
    const deleted = await this.taskModel.findByIdAndDelete(id).exec();
    return deleted!;
  }

  async complete(
    id: string,
    uid: string,
    completedBy: string,
    noteText?: string,
    photoUri?: string,
    branchIds?: string[],
  ): Promise<Task> {
    const task = await this.taskModel
      .findOne({ _id: new Types.ObjectId(id), uid } as any)
      .exec();
    if (!task) throw new NotFoundException('Task not found');
    // branchIds defined = caller is staff; undefined = merchant (no restriction)
    if (
      branchIds !== undefined &&
      task.branchId &&
      !branchIds.includes(task.branchId)
    ) {
      throw new ForbiddenException('You do not have access to this task');
    }
    const updated = await this.taskModel
      .findByIdAndUpdate(
        id,
        {
          $set: {
            isCompleted: true,
            completedAt: new Date(),
            completedBy,
            noteText: noteText ?? null,
            photoUri: photoUri ?? null,
          },
        },
        { new: true },
      )
      .exec();
    return updated!;
  }
}
