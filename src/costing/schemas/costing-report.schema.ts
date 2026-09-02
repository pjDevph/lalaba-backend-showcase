import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CostingReportDocument = CostingReport & Document;

@Schema({ collection: 'costing_reports', timestamps: true })
export class CostingReport {
  @Prop({ required: true }) uid!: string;
  @Prop({ required: true }) branchId!: string;
  @Prop({ required: true }) date!: string; // ISO date string YYYY-MM-DD
  @Prop({ type: Object, default: {} }) reportData!: Record<string, any>;
  @Prop() createdBy?: string;
  @Prop() updatedBy?: string;
  @Prop() savedAt?: Date;
  @Prop() firstSavedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export const CostingReportSchema = SchemaFactory.createForClass(CostingReport);
CostingReportSchema.index({ uid: 1, branchId: 1, date: 1 }, { unique: true });
