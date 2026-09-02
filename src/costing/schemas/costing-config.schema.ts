import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CostingConfigDocument = CostingConfig & Document;

@Schema({ collection: 'costing_configs', timestamps: true })
export class CostingConfig {
  @Prop({ required: true }) uid!: string;
  @Prop({ required: true }) branchId!: string;
  @Prop({ type: Object, default: {} }) config!: Record<string, any>;
  createdAt?: Date;
  updatedAt?: Date;
}

export const CostingConfigSchema = SchemaFactory.createForClass(CostingConfig);
CostingConfigSchema.index({ uid: 1, branchId: 1 }, { unique: true });
