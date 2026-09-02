import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  WasherServiceOffering,
  WasherServiceOfferingDocument,
} from './schemas/washer-service-offering.schema';
import {
  WasherPricingModel,
  WasherServiceTemplate,
  WasherServiceTemplateDocument,
} from '../washer-service-templates/schemas/washer-service-template.schema';
import { SetWasherServiceOfferingInput } from './dto/set-washer-service-offering.input';
import {
  assertOfferingAllowed,
  resolveWasherPricing,
  type ResolvedWasherPricing,
} from './washer-pricing.util';

@Injectable()
export class WasherServiceOfferingsService {
  constructor(
    @InjectModel(WasherServiceOffering.name)
    private readonly offeringModel: Model<WasherServiceOfferingDocument>,
    @InjectModel(WasherServiceTemplate.name)
    private readonly templateModel: Model<WasherServiceTemplateDocument>,
  ) {}

  async listForBranch(branchId: string): Promise<WasherServiceOffering[]> {
    return this.offeringModel.find({ branchId }).exec();
  }

  async findOne(
    branchId: string,
    serviceTemplateId: string,
  ): Promise<WasherServiceOffering | null> {
    return this.offeringModel.findOne({ branchId, serviceTemplateId }).exec();
  }

  /**
   * Create or replace this branch's pricing for one service. Validated against
   * the template's policy first: an inactive template, a charging method the
   * template doesn't allow, or a price outside the guardrails is rejected with
   * a message the washer can act on.
   */
  async setOffering(
    branchId: string,
    input: SetWasherServiceOfferingInput,
  ): Promise<WasherServiceOffering> {
    const template = await this.templateModel
      .findById(input.serviceTemplateId)
      .exec();
    if (!template || !template.isActive) {
      throw new BadRequestException('Service not found or no longer offered.');
    }

    assertOfferingAllowed(template, input);

    // Only the fields the chosen model uses are persisted — carrying a stale
    // load capacity on a per-kg offering would resurface if she switched back
    // and quietly price against a machine size she no longer has. Enforced
    // here rather than trusted from the client, so a hand-made mutation can't
    // leave a per-item offering holding a load capacity nobody can see.
    const model = input.pricingModel;
    const perLoad = model === WasherPricingModel.PER_LOAD;
    const baseExcess = model === WasherPricingModel.BASE_EXCESS;
    const perItem = model === WasherPricingModel.PER_ITEM;

    const patch: Partial<WasherServiceOffering> = {
      branchId,
      serviceTemplateId: String(input.serviceTemplateId),
      pricingModel: model,
      priceCentavos: input.priceCentavos,
      loadCapacityKg: perLoad ? (input.loadCapacityKg ?? null) : null,
      baseWeightKg: baseExcess ? (input.baseWeightKg ?? null) : null,
      excessRatePerKgCentavos: baseExcess
        ? (input.excessRatePerKgCentavos ?? null)
        : null,
      // Weight minimums are meaningless for per-load (a part load is a load)
      // and for per-item (nothing is weighed).
      minBillableKg: perLoad || perItem ? null : (input.minBillableKg ?? null),
      unit: perItem ? (input.unit ?? null) : null,
      minQuantity: perItem ? (input.minQuantity ?? null) : null,
      maxQuantity: perItem ? (input.maxQuantity ?? null) : null,
    };

    const saved = await this.offeringModel
      .findOneAndUpdate(
        { branchId, serviceTemplateId: String(input.serviceTemplateId) },
        { $set: patch },
        { new: true, upsert: true },
      )
      .exec();
    return saved;
  }

  /** Drops the override; the service falls back to the template's pricing. */
  async removeOffering(
    branchId: string,
    serviceTemplateId: string,
  ): Promise<boolean> {
    const res = await this.offeringModel
      .deleteOne({ branchId, serviceTemplateId })
      .exec();
    return res.deletedCount > 0;
  }

  /**
   * Resolved pricing for several templates at once, keyed by template id —
   * one query for the overrides instead of one per service. Used by the order
   * builder and by discovery, so a customer's quote and the price they browsed
   * come from the same code path.
   */
  async resolveForBranch(
    branchId: string,
    templates: WasherServiceTemplate[],
  ): Promise<Map<string, ResolvedWasherPricing>> {
    const offerings = await this.offeringModel
      .find({
        branchId,
        serviceTemplateId: { $in: templates.map((t) => String(t._id)) },
      })
      .exec();
    const byTemplate = new Map(
      offerings.map((o) => [String(o.serviceTemplateId), o]),
    );
    return new Map(
      templates.map((t) => [
        String(t._id),
        resolveWasherPricing(t, byTemplate.get(String(t._id))),
      ]),
    );
  }
}
