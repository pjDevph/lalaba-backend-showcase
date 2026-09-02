import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AddressesService } from './addresses.service';
import { AddressesResolver } from './addresses.resolver';
import { Address, AddressSchema } from './schemas/address.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Address.name, schema: AddressSchema }]),
  ],
  providers: [AddressesService, AddressesResolver],
  exports: [AddressesService],
})
export class AddressesModule {}
