import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OnlineOrdersService } from './online-orders.service';
import { OnlineOrdersResolver } from './online-orders.resolver';
import { OnlineOrder, OnlineOrderSchema } from './schemas/online-order.schema';
import { OrderEvent, OrderEventSchema } from './schemas/order-event.schema';
import {
  OnlineTransaction,
  OnlineTransactionSchema,
} from './schemas/online-transaction.schema';
import { Address, AddressSchema } from '../addresses/schemas/address.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileSchema,
} from '../washer/schemas/washer-profile.schema';
import { Service, ServiceSchema } from '../services/schemas/service.schema';
import {
  WasherServiceTemplate,
  WasherServiceTemplateSchema,
} from '../washer-service-templates/schemas/washer-service-template.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { WasherServiceOfferingsModule } from '../washer-service-offerings/washer-service-offerings.module';
import {
  Inventory,
  InventorySchema,
} from '../inventory/schemas/inventory.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Wallet, WalletSchema } from '../wallets/schemas/wallet.schema';
import {
  DailyCapCounter,
  DailyCapCounterSchema,
} from './schemas/daily-cap-counter.schema';
import { ProviderEligibilityService } from './provider-eligibility.service';
import { QualityHoldSchedulerService } from './quality-hold-scheduler.service';
import { AbandonmentSchedulerService } from './abandonment-scheduler.service';
import { WalletsModule } from '../wallets/wallets.module';
import { PlatformFeeModule } from '../platform-fee/platform-fee.module';
import { BookingAvailabilityModule } from '../booking-availability/booking-availability.module';
import { StorageModule } from '../storage/storage.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PromotionsModule } from '../promotions/promotions.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: OnlineOrder.name, schema: OnlineOrderSchema },
      { name: OrderEvent.name, schema: OrderEventSchema },
      { name: OnlineTransaction.name, schema: OnlineTransactionSchema },
      { name: Address.name, schema: AddressSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: WasherProfile.name, schema: WasherProfileSchema },
      { name: Service.name, schema: ServiceSchema },
      { name: WasherServiceTemplate.name, schema: WasherServiceTemplateSchema },
      { name: Product.name, schema: ProductSchema },
      // Products anchor to a branch through Inventory — needed for the
      // tenant-scoping check on replacement products (RISK-P0-007).
      { name: Inventory.name, schema: InventorySchema },
      // Read-only: the guarded contactPhone field resolves the customer's real
      // number, which the order snapshot deliberately stores only masked.
      { name: User.name, schema: UserSchema },
      // Read-only: marketplace payment-readiness gate (GAP-P0-006).
      { name: Wallet.name, schema: WalletSchema },
      // Acceptance-time daily-cap serializer (GAP-H-013).
      { name: DailyCapCounter.name, schema: DailyCapCounterSchema },
    ]),
    WalletsModule,
    PlatformFeeModule,
    // Per-washer pricing overrides — the order builder resolves each washer
    // line through the same helper discovery uses.
    WasherServiceOfferingsModule,
    // Booking-time slot validation + capacity reservation on createOrder.
    BookingAvailabilityModule,
    // Handover proof photos go to PRIVATE storage (they show a customer's home
    // and belongings), read back through short-lived signed URLs.
    StorageModule,
    // Self-serve promo code redemption at checkout (quoteOrder previews,
    // createOrder commits).
    PromotionsModule,
    NotificationsModule,
  ],
  providers: [
    OnlineOrdersService,
    OnlineOrdersResolver,
    ProviderEligibilityService,
    QualityHoldSchedulerService,
    AbandonmentSchedulerService,
  ],
  exports: [OnlineOrdersService],
})
export class OnlineOrdersModule {}
