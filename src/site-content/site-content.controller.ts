import { Controller, Get } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { SiteContentService } from './site-content.service';

/**
 * Public, unauthenticated read surface for the marketing website
 * (lalaba-website). REST rather than GraphQL — the website has zero
 * data-fetching infrastructure today (no GraphQL client, no codegen), and
 * adding one for three read-only lists would be disproportionate. It fetches
 * these server-side (an RSC `fetch()` with a revalidate window), so this
 * never runs cross-origin from a browser and needs no CORS entry.
 *
 * No @UseGuards anywhere in this file — deliberately public, the same way
 * this data is already public by definition (it is marketing copy meant to
 * be shown to anyone). Only ever returns isPublished:true rows.
 */
@Controller('public/site-content')
export class SiteContentController {
  constructor(private readonly siteContent: SiteContentService) {}

  // A generous but real ceiling — this is a handful of small documents behind
  // no auth, so it is a plausible scrape/abuse target even though the data
  // itself is not sensitive. Separate from the interactive-traffic budget for
  // the same reason the Xendit webhook has its own bucket: a legitimate
  // traffic spike on the site should not compete with admin panel usage.
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Get('faq')
  async faq() {
    const entries = await this.siteContent.listPublishedFaqEntries();
    return entries.map((e) => ({
      category: e.category,
      question: e.question,
      answer: e.answer,
    }));
  }

  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Get('service-areas')
  async serviceAreas() {
    const areas = await this.siteContent.listPublishedServiceAreas();
    return areas.map((a) => a.name);
  }

  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Get('announcements')
  async announcements() {
    const items = await this.siteContent.listPublishedAnnouncements();
    return items.map((a) => ({
      id: String(a._id),
      enabled: true,
      audience: a.audience,
      eyebrow: a.eyebrow,
      title: a.title,
      description: a.description,
      promoCode: a.promoCode ?? undefined,
      validityText: a.validityText ?? undefined,
      ctaText: a.ctaText,
      ctaUrl: a.ctaUrl,
      image: a.image ?? undefined,
    }));
  }
}
