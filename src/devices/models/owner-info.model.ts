import { ObjectType, Field } from '@nestjs/graphql';

// The owner/merchant who approves a staff's device — exposed to staff so the
// registration/waiting screens can say who will approve. Name only (no contact
// details).
@ObjectType()
export class OwnerInfo {
  @Field()
  name!: string;
}
