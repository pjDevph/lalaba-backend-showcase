import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { Consent, ConsentDocument } from './schemas/consent.schema';
import { ConsentInput } from './dto/consent.input';

// Mandatory policy types per self-registering role. Merchant/Washer also
// accept the business-specific agreements (fee schedule, SLA, etc.) at the
// same registration step rather than during later shop/branch setup.
const MANDATORY_POLICY_TYPES: Record<string, string[]> = {
  customer: ['terms_of_service', 'privacy_policy'],
  merchant: ['terms_of_service', 'privacy_policy', 'merchant_agreement'],
  washer: ['terms_of_service', 'privacy_policy', 'merchant_agreement'],
};

@Injectable()
export class ConsentsService {
  constructor(
    @InjectModel(Consent.name)
    private readonly consentModel: Model<ConsentDocument>,
  ) {}

  getMandatoryPolicyTypes(roleId: string): string[] {
    return MANDATORY_POLICY_TYPES[roleId] ?? [];
  }

  assertMandatoryConsentsPresent(
    roleId: string,
    consents: ConsentInput[] | undefined,
  ): void {
    const required = this.getMandatoryPolicyTypes(roleId);
    if (required.length === 0) return;

    const provided = new Set((consents ?? []).map((c) => c.policyType));
    const missing = required.filter((policyType) => !provided.has(policyType));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Missing required consent(s): ${missing.join(', ')}`,
      );
    }
  }

  async recordConsents(
    uid: string,
    consents: ConsentInput[] | undefined,
    source: string,
    session: ClientSession,
  ): Promise<void> {
    if (!consents || consents.length === 0) return;

    const rows = consents.map((c) => ({
      uid,
      policyType: c.policyType,
      version: c.version,
      locale: c.locale ?? null,
      source,
    }));

    // Unique index on (uid, policyType, version) makes this idempotent —
    // a retried write of the exact same acceptance is a harmless no-op.
    try {
      await this.consentModel.insertMany(rows, { session, ordered: false });
    } catch (error: any) {
      const isDuplicateKeyOnly =
        error?.code === 11000 ||
        (Array.isArray(error?.writeErrors) &&
          error.writeErrors.every((e: any) => e.code === 11000));
      if (!isDuplicateKeyOnly) throw error;
    }
  }

  async myConsents(uid: string): Promise<Consent[]> {
    return this.consentModel.find({ uid }).sort({ createdAt: -1 }).exec();
  }
}
