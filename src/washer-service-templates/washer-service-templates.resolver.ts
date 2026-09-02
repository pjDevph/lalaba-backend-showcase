import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { WasherServiceTemplatesService } from './washer-service-templates.service';
import { WasherServiceTemplate } from './schemas/washer-service-template.schema';
import { CreateWasherServiceTemplateInput } from './dto/create-washer-service-template.input';
import { UpdateWasherServiceTemplateInput } from './dto/update-washer-service-template.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Resolver(() => WasherServiceTemplate)
@UseGuards(GqlAuthGuard, RolesGuard)
export class WasherServiceTemplatesResolver {
  constructor(
    private readonly templatesService: WasherServiceTemplatesService,
  ) {}

  // Washer-facing: browse what she can choose to offer. Any authenticated
  // washer may read the active catalog; only Admin can change it.
  @Roles('washer', 'admin')
  @Query(() => [WasherServiceTemplate], {
    name: 'availableWasherServiceTemplates',
  })
  async availableWasherServiceTemplates(): Promise<WasherServiceTemplate[]> {
    return this.templatesService.listActive();
  }

  @Roles('admin')
  @Query(() => [WasherServiceTemplate], { name: 'allWasherServiceTemplates' })
  async allWasherServiceTemplates(): Promise<WasherServiceTemplate[]> {
    return this.templatesService.listAll();
  }

  @Roles('admin')
  @Mutation(() => WasherServiceTemplate)
  async createWasherServiceTemplate(
    @Args('input') input: CreateWasherServiceTemplateInput,
  ): Promise<WasherServiceTemplate> {
    return this.templatesService.create(input);
  }

  @Roles('admin')
  @Mutation(() => WasherServiceTemplate)
  async updateWasherServiceTemplate(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateWasherServiceTemplateInput,
  ): Promise<WasherServiceTemplate> {
    return this.templatesService.update(id, input);
  }

  @Roles('admin')
  @Mutation(() => WasherServiceTemplate)
  async setWasherServiceTemplateActive(
    @Args('id', { type: () => ID }) id: string,
    @Args('isActive') isActive: boolean,
  ): Promise<WasherServiceTemplate> {
    return this.templatesService.setActive(id, isActive);
  }
}
