import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Wallet, WalletDocument } from './schemas/wallet.schema';

/**
 * Shared, provider-type-agnostic wallet acceptance gate (GAP-P0-004).
 *
 * Exported from WalletsModule for the online-orders module (Agent 4) to call
 * for EVERY provider type at acceptance time — the current inline gate only
 * runs for washers, letting merchants accept with an empty/negative wallet.
 * Error messages intentionally match the existing inline washer gate so the
 * swap is behavior-preserving for the FE.
 */
@Injectable()
export class WalletAcceptanceGuardService {
  constructor(
    @InjectModel(Wallet.name)
    private readonly walletModel: Model<WalletDocument>,
  ) {}

  /**
   * Throws (BadRequestException) when the branch's wallet is negative or
   * cannot cover the order's estimated platform fee; resolves silently when
   * acceptance is allowed. A missing wallet counts as insufficient.
   */
  async assertCanAcceptOrder(
    branchId: string,
    estimatedFeeCentavos: number,
  ): Promise<void> {
    const wallet = await this.walletModel.findOne({ branchId }).exec();
    const balance = wallet?.balanceCentavos ?? 0;

    if (balance < 0) {
      throw new BadRequestException({
        statusCode: 400,
        message:
          'Wallet balance is negative. Top up before accepting new orders.',
      });
    }
    if (!wallet || balance < estimatedFeeCentavos) {
      throw new BadRequestException({
        statusCode: 400,
        message:
          "Insufficient wallet balance to cover this order's platform fee.",
      });
    }
  }
}
