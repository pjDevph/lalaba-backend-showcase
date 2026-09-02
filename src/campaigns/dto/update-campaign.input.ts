import { InputType, PartialType } from '@nestjs/graphql';
import { CreateCampaignInput } from './create-campaign.input';

/**
 * Every field optional. Editing a live campaign does NOT re-show it to anyone
 * who has already seen it — their impression row still stands — so swapping
 * the image on a running ONCE_EVER campaign reaches only people who have not
 * seen it yet. That is surfaced in the admin UI rather than worked around
 * here; silently deleting impressions to force a re-show would break the one
 * guarantee the frequency rule makes.
 */
@InputType()
export class UpdateCampaignInput extends PartialType(CreateCampaignInput) {}
