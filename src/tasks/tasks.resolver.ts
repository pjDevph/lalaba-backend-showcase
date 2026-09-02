import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { TasksService } from './tasks.service';
import { Task } from './schemas/task.schema';
import { CreateTaskInput } from './dto/create-task.input';
import { UpdateTaskInput } from './dto/update-task.input';
import { TaskFilterInput } from './dto/task-filter.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';

// SEC-026..030 — role floor for the whole resolver.
//
// Everything here is merchant-side: a POS terminal, a stock room, a service
// catalogue, a branch task list. The queries used to be reachable by ANY
// authenticated account — a customer or a courier could call them. Nothing
// leaked, because each one derives merchantId from the caller and a customer
// simply matched nothing, but that made the tenancy scoping the only thing
// standing between these and a real breach. One query that takes an id from
// its arguments instead of the session would have been enough.
//
// Note RolesGuard returns true when no @Roles metadata is present, so the
// absence of this line was silent — nothing failed, nothing warned.
@Resolver(() => Task)
@Roles('merchant', 'staff')
@UseGuards(GqlAuthGuard, RolesGuard)
export class TasksResolver {
  constructor(private readonly tasksService: TasksService) {}

  private getMerchantId(user: User): string {
    const role = user.role as unknown as Role;
    return role?.roleId === 'staff' ? user.merchantId! : user._id;
  }

  @Query(() => [Task], { name: 'myTasks' })
  async getMyTasks(
    @Args('filter', { type: () => TaskFilterInput, nullable: true })
    filter: TaskFilterInput,
    @CurrentUser() user: User,
  ): Promise<Task[]> {
    const merchantId = this.getMerchantId(user);
    const role = user.role as unknown as Role;
    const isStaff = role?.roleId === 'staff';
    if (isStaff && filter) {
      filter.isVisibleToStaff = true;
    } else if (isStaff) {
      filter = { isVisibleToStaff: true };
    }
    return this.tasksService.findAll(merchantId, filter);
  }

  @Roles('merchant')
  @UseGuards(RolesGuard)
  @Mutation(() => Task)
  async createTask(
    @Args('input') input: CreateTaskInput,
    @CurrentUser() user: User,
  ): Promise<Task> {
    return this.tasksService.create(input, user);
  }

  @Roles('merchant')
  @UseGuards(RolesGuard)
  @Mutation(() => Task)
  async updateTask(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateTaskInput,
    @CurrentUser() user: User,
  ): Promise<Task> {
    const role = user.role as unknown as Role;
    const isStaff = role?.roleId === 'staff';
    // ?? [] ensures undefined branchIds never silently bypasses the IDOR guard in the service
    const branchIds = isStaff ? (user.branchIds ?? []) : undefined;
    return this.tasksService.update(
      id,
      this.getMerchantId(user),
      input,
      branchIds,
    );
  }

  @Roles('merchant')
  @UseGuards(RolesGuard)
  @Mutation(() => Task)
  async deleteTask(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
  ): Promise<Task> {
    const role = user.role as unknown as Role;
    const isStaff = role?.roleId === 'staff';
    const branchIds = isStaff ? (user.branchIds ?? []) : undefined;
    return this.tasksService.delete(id, this.getMerchantId(user), branchIds);
  }

  @Mutation(() => Task)
  async completeTask(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: User,
    @Args('noteText', { nullable: true }) noteText?: string,
    @Args('photoUri', { nullable: true }) photoUri?: string,
  ): Promise<Task> {
    const role = user.role as unknown as Role;
    const isStaff = role?.roleId === 'staff';
    const branchIds = isStaff ? (user.branchIds ?? []) : undefined;
    const uid = this.getMerchantId(user);
    // `displayName` does not exist on User (the schema has firstName/lastName/
    // email), so the old `(user as any).displayName` was always undefined and
    // this silently recorded an email address where a person's name was meant.
    // Same shape as adminNameOf() in platform-fee.resolver.ts.
    const fullName = [user.firstName, user.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();
    const completedBy = fullName || user.email || 'Unknown';
    return this.tasksService.complete(
      id,
      uid,
      completedBy,
      noteText,
      photoUri,
      branchIds,
    );
  }
}
