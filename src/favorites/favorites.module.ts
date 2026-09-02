import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FavoritesService } from './favorites.service';
import { FavoritesResolver } from './favorites.resolver';
import { Favorite, FavoriteSchema } from './schemas/favorite.schema';
import { DiscoveryModule } from '../discovery/discovery.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Favorite.name, schema: FavoriteSchema },
    ]),
    DiscoveryModule, // exports DiscoveryService for card rendering
  ],
  providers: [FavoritesService, FavoritesResolver],
})
export class FavoritesModule {}
