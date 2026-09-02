import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Branch, BranchDocument } from './schemas/branch.schema';
import { CreateBranchInput } from './dto/create-branch.input';
import { UpdateBranchInput } from './dto/update-branch.input';
import { BranchFilterInput } from './dto/branch-filter.input';
import { PaginatedBranches } from './models/paginated-branches.model';
import { WalletsService } from '../wallets/wallets.service';
import { exactMatchInsensitive } from '../common/utils/escape-regex.util';

@Injectable()
export class BranchesService {
  constructor(
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    private readonly walletsService: WalletsService,
  ) {}

  async create(
    input: CreateBranchInput | CreateBranchInput[],
    uid: string,
  ): Promise<Branch[]> {
    const inputs = Array.isArray(input) ? input : [input];
    const names = inputs.map((i) => i.branchName.trim().toLowerCase());
    const duplicateInBatch = names.length !== new Set(names).size;
    if (duplicateInBatch)
      throw new BadRequestException(
        'Duplicate branch names in the same request',
      );
    const existing = await this.branchModel
      .findOne({
        uid,
        branchName: {
          $in: inputs.map((i) => exactMatchInsensitive(i.branchName.trim())),
        },
      })
      .exec();
    if (existing)
      throw new BadRequestException(
        `Branch name "${existing.branchName}" already exists`,
      );
    const created = await this.branchModel.insertMany(
      inputs.map((i) => ({ ...i, uid })),
    );
    // Every branch gets its own wallet immediately (§17). Funding is NOT
    // gated on verification — see initializeTopUp in wallets.service.ts.
    await Promise.all(
      created.map((branch) =>
        this.walletsService.createWallet(String(branch._id)),
      ),
    );
    return created;
  }

  async findAllByMerchant(
    uid: string,
    filter: BranchFilterInput = {},
  ): Promise<PaginatedBranches> {
    const { isActive, search, limit = 10, offset = 0 } = filter;
    const safeLimit = Math.min(limit ?? 10, 100);
    const query: Record<string, any> = { uid };
    if (isActive !== undefined) query.isActive = isActive;
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.branchName = { $regex: escaped, $options: 'i' };
    }
    const [data, total] = await Promise.all([
      this.branchModel.find(query).skip(offset).limit(safeLimit).exec(),
      this.branchModel.countDocuments(query).exec(),
    ]);
    return { data, total, limit, offset };
  }

  async findById(id: string, uid: string): Promise<Branch> {
    const branch = await this.branchModel.findById(id).exec();
    if (!branch || branch.uid !== uid)
      throw new NotFoundException('Branch not found.');
    return branch;
  }

  async update(
    id: string,
    uid: string,
    input: UpdateBranchInput,
  ): Promise<Branch> {
    const branch = await this.branchModel.findById(id).exec();
    if (!branch || branch.uid !== uid)
      throw new NotFoundException('Branch not found.');
    if (input.branchName) {
      const conflictFilter: Record<string, any> = {
        uid,
        branchName: exactMatchInsensitive(input.branchName.trim()),
        _id: { $ne: id },
      };
      const conflict = await this.branchModel.findOne(conflictFilter).exec();
      if (conflict)
        throw new BadRequestException(
          `Branch name "${input.branchName}" already exists`,
        );
    }
    const updated = await this.branchModel
      .findByIdAndUpdate(id, { $set: input }, { new: true })
      .exec();
    return updated!;
  }

  /**
   * Deferred-settlement opt-in (§14). Deliberately its own mutation rather than
   * a field on UpdateBranchInput: it is an operating setting like the
   * open/closed toggle, not part of the branch profile, and a money rule should
   * not be flippable as a side effect of editing an address.
   *
   * Existing orders keep whatever this said when they were booked — the value
   * is snapshotted onto the order, so turning it off stops new deferrals
   * without retracting one a customer was already promised.
   */
  async setPayAtHandover(
    id: string,
    uid: string,
    enabled: boolean,
  ): Promise<Branch> {
    const branch = await this.branchModel.findById(id).exec();
    if (!branch || branch.uid !== uid)
      throw new NotFoundException('Branch not found.');
    const updated = await this.branchModel
      .findByIdAndUpdate(
        id,
        { $set: { allowsPayAtHandover: enabled } },
        { new: true },
      )
      .exec();
    return updated!;
  }

  /**
   * The open/closed toggle on the provider's own dashboard — distinct from
   * `isActive` (merchant-level archive/restore) and from KYC/verification
   * gates: this is the one switch a provider flips themselves, minute to
   * minute, to stop new bookings without touching anything else.
   */
  async setOnline(id: string, uid: string, isOnline: boolean): Promise<Branch> {
    const branch = await this.branchModel.findById(id).exec();
    if (!branch || branch.uid !== uid)
      throw new NotFoundException('Branch not found.');
    const updated = await this.branchModel
      .findByIdAndUpdate(id, { $set: { isOnline } }, { new: true })
      .exec();
    return updated!;
  }

  async archive(id: string, uid: string): Promise<Branch> {
    const branch = await this.branchModel.findById(id).exec();
    if (!branch || branch.uid !== uid)
      throw new NotFoundException('Branch not found.');
    if (!branch.isActive)
      throw new BadRequestException(`Branch is already archived`);
    const archived = await this.branchModel
      .findByIdAndUpdate(id, { $set: { isActive: false } }, { new: true })
      .exec();
    return archived!;
  }

  async restore(id: string, uid: string): Promise<Branch> {
    const branch = await this.branchModel.findById(id).exec();
    if (!branch || branch.uid !== uid)
      throw new NotFoundException('Branch not found.');
    if (branch.isActive)
      throw new BadRequestException(`Branch is already active`);
    const restored = await this.branchModel
      .findByIdAndUpdate(id, { $set: { isActive: true } }, { new: true })
      .exec();
    return restored!;
  }
}
