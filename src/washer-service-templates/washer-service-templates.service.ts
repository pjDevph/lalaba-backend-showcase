import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  WasherPricingControl,
  WasherPricingModel,
  WasherServiceTemplate,
  WasherServiceTemplateDocument,
} from './schemas/washer-service-template.schema';
import { CreateWasherServiceTemplateInput } from './dto/create-washer-service-template.input';
import { UpdateWasherServiceTemplateInput } from './dto/update-washer-service-template.input';
import { exactMatchInsensitive } from '../common/utils/escape-regex.util';

/**
 * Guardrails are optional and independent, but an inverted pair would reject
 * every price a washer could possibly enter — with two separate error messages
 * that each look wrong on their own.
 */
function assertGuardrailsCoherent(
  min?: number | null,
  max?: number | null,
): void {
  if (min != null && max != null && min > max) {
    throw new BadRequestException(
      'The minimum price cannot be higher than the maximum price.',
    );
  }
}

/**
 * A platform-priced template IS the price every washer charges, so it has to
 * be complete on its own — there is no washer-side editor to fill in a missing
 * load capacity later. Mirrors assertOfferingAllowed's per-model completeness
 * checks, on the other side of the same decision.
 *
 * Only enforced under PLATFORM_FIXED: under WASHER_SET these fields describe
 * the fallback price, which is always base + excess.
 */
function assertPlatformPricingComplete(
  template: Pick<
    WasherServiceTemplate,
    'pricingControl' | 'platformPricingModel'
  > &
    Partial<
      Pick<
        WasherServiceTemplate,
        'platformLoadCapacityKg' | 'platformUnit' | 'excessRatePerKgCentavos'
      >
    >,
): void {
  if (template.pricingControl !== WasherPricingControl.PLATFORM_FIXED) return;

  if (template.platformPricingModel === WasherPricingModel.PER_LOAD) {
    const capacity = template.platformLoadCapacityKg;
    if (capacity == null || capacity <= 0) {
      throw new BadRequestException(
        'Set how many kilos one load covers, so bigger baskets are charged for the extra loads they need.',
      );
    }
  }
  if (template.platformPricingModel === WasherPricingModel.PER_ITEM) {
    if (!template.platformUnit) {
      throw new BadRequestException(
        'Choose what this service counts — pieces, pairs, sets or panels.',
      );
    }
  }
}

@Injectable()
export class WasherServiceTemplatesService {
  constructor(
    @InjectModel(WasherServiceTemplate.name)
    private readonly templateModel: Model<WasherServiceTemplateDocument>,
  ) {}

  async create(
    input: CreateWasherServiceTemplateInput,
  ): Promise<WasherServiceTemplate> {
    const existing = await this.templateModel
      .findOne({ name: exactMatchInsensitive(input.name.trim()) })
      .exec();
    if (existing) {
      throw new BadRequestException(
        `A service template named "${input.name}" already exists`,
      );
    }
    assertGuardrailsCoherent(input.minPriceCentavos, input.maxPriceCentavos);
    assertPlatformPricingComplete({
      pricingControl: input.pricingControl ?? WasherPricingControl.WASHER_SET,
      platformPricingModel:
        input.platformPricingModel ?? WasherPricingModel.BASE_EXCESS,
      platformLoadCapacityKg: input.platformLoadCapacityKg,
      platformUnit: input.platformUnit,
    });
    return this.templateModel.create(input);
  }

  async update(
    id: string,
    input: UpdateWasherServiceTemplateInput,
  ): Promise<WasherServiceTemplate> {
    // A partial update can raise the floor above an already-stored ceiling, so
    // the check runs against the merged values, not just what was sent.
    const current = await this.templateModel.findById(id).exec();
    if (!current) throw new NotFoundException('Service template not found');
    assertGuardrailsCoherent(
      input.minPriceCentavos ?? current.minPriceCentavos,
      input.maxPriceCentavos ?? current.maxPriceCentavos,
    );
    // Same reason: switching an existing template to PLATFORM_FIXED + PER_LOAD
    // without sending a capacity must fail here, not price every washer's
    // basket as a single load later.
    assertPlatformPricingComplete({
      pricingControl: input.pricingControl ?? current.pricingControl,
      platformPricingModel:
        input.platformPricingModel ??
        current.platformPricingModel ??
        WasherPricingModel.BASE_EXCESS,
      platformLoadCapacityKg:
        input.platformLoadCapacityKg ?? current.platformLoadCapacityKg,
      platformUnit: input.platformUnit ?? current.platformUnit,
    });

    const updated = await this.templateModel
      .findByIdAndUpdate(id, { $set: input }, { new: true })
      .exec();
    if (!updated) throw new NotFoundException('Service template not found');
    return updated;
  }

  async setActive(
    id: string,
    isActive: boolean,
  ): Promise<WasherServiceTemplate> {
    const updated = await this.templateModel
      .findByIdAndUpdate(id, { $set: { isActive } }, { new: true })
      .exec();
    if (!updated) throw new NotFoundException('Service template not found');
    return updated;
  }

  async listAll(): Promise<WasherServiceTemplate[]> {
    return this.templateModel.find().sort({ name: 1 }).exec();
  }

  async listActive(): Promise<WasherServiceTemplate[]> {
    return this.templateModel.find({ isActive: true }).sort({ name: 1 }).exec();
  }

  /** Returns only the subset of the given IDs that are real, active templates. */
  async filterValidActiveIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const found = await this.templateModel
      .find({ _id: { $in: ids }, isActive: true } as any)
      .select('_id')
      .exec();
    return found.map((doc) => String(doc._id));
  }
}
