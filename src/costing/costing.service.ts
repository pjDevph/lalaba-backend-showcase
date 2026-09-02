import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CostingConfig,
  CostingConfigDocument,
} from './schemas/costing-config.schema';
import {
  CostingReport,
  CostingReportDocument,
} from './schemas/costing-report.schema';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import { CostingReportEntry } from './models/costing-report-entry.model';
import { CostingReportStub } from './models/costing-report-stub.model';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';

@Injectable()
export class CostingService {
  constructor(
    @InjectModel(CostingConfig.name)
    private readonly costingConfigModel: Model<CostingConfigDocument>,
    @InjectModel(CostingReport.name)
    private readonly costingReportModel: Model<CostingReportDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
  ) {}

  private async assertBranchOwnership(
    branchId: string,
    uid: string,
  ): Promise<void> {
    const branch = await this.branchModel
      .findOne({ _id: branchId, uid } as any)
      .exec();
    if (!branch)
      throw new ForbiddenException('Branch not found or access denied');
  }

  getMerchantId(user: User): string {
    const role = user.role as unknown as Role;
    return role?.roleId === 'staff' ? user.merchantId! : user._id;
  }

  async getCostingConfig(
    branchId: string,
    uid: string,
  ): Promise<Record<string, any>> {
    await this.assertBranchOwnership(branchId, uid);
    const doc = await this.costingConfigModel.findOne({ uid, branchId }).exec();
    return doc?.config ?? {};
  }

  async upsertCostingConfig(
    branchId: string,
    uid: string,
    config: Record<string, unknown>,
  ): Promise<any> {
    await this.assertBranchOwnership(branchId, uid);
    const saved = await this.costingConfigModel
      .findOneAndUpdate(
        { uid, branchId },
        { $set: { config } },
        { upsert: true, new: true },
      )
      .exec();
    return saved.config;
  }

  async getCostingReports(
    branchId: string,
    uid: string,
    limit = 90,
  ): Promise<CostingReportEntry[]> {
    await this.assertBranchOwnership(branchId, uid);
    const docs = await this.costingReportModel
      .find({ uid, branchId })
      .sort({ date: -1 })
      .limit(limit)
      .exec();

    return docs.map((doc) => {
      const data = doc.reportData ?? {};
      return {
        id: (doc as any)._id.toString(),
        date: doc.date,
        kilos: data.kilos,
        revenue: data.revenue,
        recipeCost: data.recipeCost,
        electricity: data.electricity,
        lpg: data.lpg,
        water: data.water,
        additionalDaily: data.additionalDaily,
        fixedTotal: data.fixedTotal,
        operating: data.operating,
        totalCost: data.totalCost,
        costPerKilo: data.costPerKilo,
        trueMargin: data.trueMargin,
        elecReading: data.elecReading,
        waterReading: data.waterReading,
        lpgReading: data.lpgReading,
        oneOffCosts: data.oneOffCosts,
        units: data.units,
        branches: data.branches,
        savedAt: doc.savedAt,
        createdBy: doc.createdBy,
        updatedBy: doc.updatedBy,
        firstSavedAt: doc.firstSavedAt,
      };
    });
  }

  async upsertCostingReport(
    branchId: string,
    uid: string,
    report: Record<string, unknown>,
    userId: string,
  ): Promise<CostingReportStub> {
    await this.assertBranchOwnership(branchId, uid);
    if (
      !report?.date ||
      typeof report.date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(report.date)
    ) {
      throw new BadRequestException('Please provide a valid report date.');
    }
    const doc = await this.costingReportModel
      .findOneAndUpdate(
        { uid, branchId, date: report.date },
        {
          $set: { reportData: report, updatedBy: userId, savedAt: new Date() },
          $setOnInsert: { createdBy: userId, firstSavedAt: new Date() },
        },
        { upsert: true, new: true },
      )
      .exec();

    return {
      id: (doc as any)._id.toString(),
      date: doc.date,
    };
  }
}
