import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { Address, AddressDocument } from './schemas/address.schema';
import { CreateAddressInput } from './dto/create-address.input';
import { UpdateAddressInput } from './dto/update-address.input';

const MAX_ADDRESSES_PER_CUSTOMER = 10;

@Injectable()
export class AddressesService {
  constructor(
    @InjectModel(Address.name)
    private readonly addressModel: Model<AddressDocument>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async myAddresses(uid: string): Promise<Address[]> {
    return this.addressModel
      .find({ uid, isArchived: false })
      .sort({ isDefault: -1, createdAt: -1 })
      .exec();
  }

  private async findOwned(id: string, uid: string): Promise<AddressDocument> {
    const address = await this.addressModel.findById(id).exec();
    if (!address || address.isArchived) {
      throw new NotFoundException('Address not found');
    }
    if (address.uid !== uid) {
      throw new ForbiddenException('You do not own this address');
    }
    return address;
  }

  async createAddress(
    uid: string,
    input: CreateAddressInput,
  ): Promise<Address> {
    const activeCount = await this.addressModel.countDocuments({
      uid,
      isArchived: false,
    });
    if (activeCount >= MAX_ADDRESSES_PER_CUSTOMER) {
      throw new BadRequestException(
        `Maximum of ${MAX_ADDRESSES_PER_CUSTOMER} saved addresses reached.`,
      );
    }

    // First saved address always becomes the default, regardless of what the
    // client passed — there must never be zero default addresses once one exists.
    const isFirstAddress = activeCount === 0;
    const makeDefault = isFirstAddress || input.isDefault === true;

    const session = await this.connection.startSession();
    let saved: AddressDocument;
    try {
      await session.withTransaction(async () => {
        if (makeDefault) {
          await this.addressModel.updateMany(
            { uid, isDefault: true },
            { $set: { isDefault: false } },
            { session },
          );
        }

        const doc = new this.addressModel({
          uid,
          label: input.label ?? null,
          address: input.address,
          mapLocation: input.mapLocation,
          accessInstructions: input.accessInstructions ?? null,
          isDefault: makeDefault,
        });
        saved = await doc.save({ session });
      });
    } finally {
      await session.endSession();
    }

    return saved!;
  }

  async updateAddress(
    id: string,
    uid: string,
    input: UpdateAddressInput,
  ): Promise<Address> {
    const existing = await this.findOwned(id, uid);

    const session = await this.connection.startSession();
    let saved: AddressDocument;
    try {
      await session.withTransaction(async () => {
        if (input.isDefault === true && !existing.isDefault) {
          await this.addressModel.updateMany(
            { uid, isDefault: true },
            { $set: { isDefault: false } },
            { session },
          );
        }

        if (input.label !== undefined) existing.label = input.label;
        if (input.address !== undefined) existing.address = input.address;
        if (input.mapLocation !== undefined)
          existing.mapLocation = input.mapLocation;
        if (input.accessInstructions !== undefined)
          existing.accessInstructions = input.accessInstructions;
        if (input.isDefault !== undefined) existing.isDefault = input.isDefault;

        saved = await existing.save({ session });
      });
    } finally {
      await session.endSession();
    }

    return saved!;
  }

  async setDefaultAddress(id: string, uid: string): Promise<Address> {
    const existing = await this.findOwned(id, uid);
    if (existing.isDefault) return existing;

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.addressModel.updateMany(
          { uid, isDefault: true },
          { $set: { isDefault: false } },
          { session },
        );
        existing.isDefault = true;
        await existing.save({ session });
      });
    } finally {
      await session.endSession();
    }

    return existing;
  }

  async deleteAddress(id: string, uid: string): Promise<boolean> {
    const existing = await this.findOwned(id, uid);
    const wasDefault = existing.isDefault;

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        existing.isArchived = true;
        existing.archivedAt = new Date();
        existing.isDefault = false;
        await existing.save({ session });

        // Promote the most recently added remaining address to default so a
        // customer is never left with zero default addresses.
        if (wasDefault) {
          const next = await this.addressModel
            .findOne({ uid, isArchived: false })
            .sort({ createdAt: -1 })
            .session(session)
            .exec();
          if (next) {
            next.isDefault = true;
            await next.save({ session });
          }
        }
      });
    } finally {
      await session.endSession();
    }

    return true;
  }
}
