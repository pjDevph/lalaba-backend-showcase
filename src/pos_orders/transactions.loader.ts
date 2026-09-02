import { Injectable, Scope } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import DataLoader from 'dataloader';
import {
  PosTransaction,
  PosTransactionDocument,
} from '../pos_transactions/schemas/pos-transaction.schema';

@Injectable({ scope: Scope.REQUEST })
export class TransactionsLoader {
  private readonly loader: DataLoader<string, PosTransaction[]>;

  constructor(
    @InjectModel(PosTransaction.name)
    private readonly txModel: Model<PosTransactionDocument>,
  ) {
    this.loader = new DataLoader<string, PosTransaction[]>(
      async (orderIds) => {
        const txList = await this.txModel
          .find({ orderId: { $in: [...orderIds] } })
          .sort({ createdAt: 1 })
          .exec();
        const byOrder = new Map<string, PosTransaction[]>();
        for (const tx of txList) {
          const arr = byOrder.get(tx.orderId) ?? [];
          arr.push(tx);
          byOrder.set(tx.orderId, arr);
        }
        return orderIds.map((id) => byOrder.get(id) ?? []);
      },
      { cache: false },
    );
  }

  load(orderId: string): Promise<PosTransaction[]> {
    return this.loader.load(orderId);
  }
}
