import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  PosTransaction,
  PosTransactionSchema,
} from './schemas/pos-transaction.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PosTransaction.name, schema: PosTransactionSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class PosTransactionsModule {}
