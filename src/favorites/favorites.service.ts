import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Favorite, FavoriteDocument } from './schemas/favorite.schema';
import { DiscoveryService } from '../discovery/discovery.service';
import { ProviderCard } from '../discovery/models/provider-card.model';
import { ProviderType } from '../online-orders/schemas/order-status.enum';

@Injectable()
export class FavoritesService {
  constructor(
    @InjectModel(Favorite.name)
    private readonly favoriteModel: Model<FavoriteDocument>,
    private readonly discoveryService: DiscoveryService,
  ) {}

  // Returns favorites rendered as full provider cards (screen 054), newest first.
  async myFavorites(uid: string): Promise<ProviderCard[]> {
    const favs = await this.favoriteModel
      .find({ uid })
      .sort({ createdAt: -1 })
      .exec();
    return this.discoveryService.cardsForFavorites(
      uid,
      favs.map((f) => ({ branchId: f.branchId, providerType: f.providerType })),
    );
  }

  // Idempotent via the unique (uid, branchId) index — a repeat tap is a no-op.
  async addFavorite(
    uid: string,
    branchId: string,
    providerType: ProviderType,
  ): Promise<boolean> {
    await this.favoriteModel
      .updateOne(
        { uid, branchId },
        { $setOnInsert: { uid, branchId, providerType } },
        { upsert: true },
      )
      .exec();
    return true;
  }

  async removeFavorite(uid: string, branchId: string): Promise<boolean> {
    await this.favoriteModel.deleteOne({ uid, branchId }).exec();
    return true;
  }
}
