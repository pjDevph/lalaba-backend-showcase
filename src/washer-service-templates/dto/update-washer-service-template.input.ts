import { InputType, PartialType } from '@nestjs/graphql';
import { CreateWasherServiceTemplateInput } from './create-washer-service-template.input';

@InputType()
export class UpdateWasherServiceTemplateInput extends PartialType(
  CreateWasherServiceTemplateInput,
) {}
