import { InputType, Field, ID } from '@nestjs/graphql';
import { IsArray, IsEnum, IsString } from 'class-validator';
import { PermissionGroup } from '../../permissions/permission-groups';

/**
 * One branch and the access granted on it.
 *
 * Owners choose GROUPS, never permission names — four switches per branch
 * rather than a twenty-row matrix. The server expands them, so the app cannot
 * hold its own opinion about which permissions "Orders" means; that opinion
 * lives in permission-groups.ts alone.
 */
@InputType()
export class BranchAccessInput {
  @IsString()
  @Field(() => ID)
  branchId!: string;

  @IsArray()
  @IsEnum(PermissionGroup, {
    each: true,
    message: 'groups must contain only known permission groups',
  })
  @Field(() => [PermissionGroup], { defaultValue: [] })
  groups!: PermissionGroup[];
}
