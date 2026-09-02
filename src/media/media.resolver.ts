import { Resolver, Mutation, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { MediaService } from './media.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * SEC-006 — uploadMedia writes caller-supplied bytes into the PUBLIC bucket
 * under a caller-chosen (allowlisted) folder. It was authenticated but
 * otherwise unrestricted, so ANY account could park arbitrary files on the
 * project's public origin, and the stored extension came purely from the
 * client-declared MIME type with no look at the actual bytes.
 *
 * Two changes close it:
 *   1. role restriction — only the provider-side roles that legitimately do
 *      branding/product/KYC-adjacent uploads may call it;
 *   2. content sniffing in MediaService — the declared MIME must match the
 *      file's real magic bytes.
 */
export const MEDIA_UPLOAD_ROLES = [
  'admin',
  'support',
  'merchant',
  'washer',
  'staff',
] as const;

@Resolver()
@Roles(...MEDIA_UPLOAD_ROLES)
@UseGuards(GqlAuthGuard, RolesGuard)
export class MediaResolver {
  constructor(private readonly mediaService: MediaService) {}

  @Mutation(() => String, { name: 'uploadMedia' })
  async uploadMedia(
    @Args('base64') base64: string,
    @Args('mimeType') mimeType: string,
    @Args('folder') folder: string,
  ): Promise<string> {
    return this.mediaService.uploadBase64(base64, mimeType, folder);
  }
}
