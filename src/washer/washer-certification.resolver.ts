import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { WasherService } from './washer.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';

// Separate from WasherResolver because that class is entirely @Roles('washer')
// — certification evidence must also be readable by admin/support reviewers,
// exactly like kycDocumentUrl.
@Resolver()
@Roles('washer', 'admin', 'support')
@UseGuards(GqlAuthGuard, RolesGuard)
export class WasherCertificationResolver {
  constructor(private readonly washerService: WasherService) {}

  @Query(() => [String], {
    name: 'certificationProofUrls',
    description:
      "Short-lived (300s) signed read URLs for a washer's certification evidence. The washer herself, or an admin/support reviewer, only. During the storage migration any not-yet-migrated legacy public URLs are appended verbatim.",
  })
  async certificationProofUrls(
    @CurrentUser() user: User,
    @Args('washerUid', { type: () => ID, nullable: true })
    washerUid?: string,
  ): Promise<string[]> {
    return this.washerService.certificationProofUrls(user, washerUid);
  }
}
