import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { CacheModule } from '@nestjs/cache-manager';
import { WinstonModule } from 'nest-winston';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { join } from 'path';
import { depthLimit } from './common/graphql/depth-limit';
import { formatGraphQLError } from './common/graphql/format-error';
import { FirebaseModule } from './firebase/firebase.module';
import { EmailModule } from './email/email.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AppResolver } from './app.resolver';
import { UsersModule } from './users/users.module';
import { BranchesModule } from './branches/branches.module';
import { DevicesModule } from './devices/devices.module';
import { StaffModule } from './staff/staff.module';
import { InventoryModule } from './inventory/inventory.module';
import { ProductsModule } from './products/products.module';
import { ServicesModule } from './services/services.module';
import { PermissionsModule } from './permissions/permissions.module';
import { RolesModule } from './roles/roles.module';
import { PosOrdersModule } from './pos_orders/pos-orders.module';
import { PosTransactionsModule } from './pos_transactions/pos-transactions.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ActivityLogsModule } from './activity-logs/activity-logs.module';
import { TasksModule } from './tasks/tasks.module';
import { CostingModule } from './costing/costing.module';
import { WasherModule } from './washer/washer.module';
import { MediaModule } from './media/media.module';
import { BiometricModule } from './biometric/biometric.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ConsentsModule } from './consents/consents.module';
import { AddressesModule } from './addresses/addresses.module';
import { WasherServiceTemplatesModule } from './washer-service-templates/washer-service-templates.module';
import { WasherServiceOfferingsModule } from './washer-service-offerings/washer-service-offerings.module';
import { WasherServiceProductsModule } from './washer-service-products/washer-service-products.module';
import { OnlineOrdersModule } from './online-orders/online-orders.module';
import { PlatformFeeModule } from './platform-fee/platform-fee.module';
import { WalletsModule } from './wallets/wallets.module';
import { AdminAuditModule } from './admin-audit/admin-audit.module';
import { SupportTicketsModule } from './support-tickets/support-tickets.module';
import { DirectoryModule } from './directory/directory.module';
import { SearchModule } from './search/search.module';
import { OperationalContextModule } from './operational-context/operational-context.module';
import { NowQueueModule } from './now-queue/now-queue.module';
import { PromotionsModule } from './promotions/promotions.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { PlatformAnalyticsModule } from './platform-analytics/platform-analytics.module';
import { SiteContentModule } from './site-content/site-content.module';
import { OrderDashboardModule } from './order-dashboard/order-dashboard.module';
import { RatingsModule } from './ratings/ratings.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { BookingPolicyModule } from './booking-policy/booking-policy.module';
import { BookingAvailabilityModule } from './booking-availability/booking-availability.module';
import { FavoritesModule } from './favorites/favorites.module';
import { ChatModule } from './chat/chat.module';
import { PresenceModule } from './presence/presence.module';
import { KycModule } from './kyc/kyc.module';
import { CourierVerificationModule } from './courier-verification/courier-verification.module';
import { AccountDeletionModule } from './account-deletion/account-deletion.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { JSONScalar } from './scalars/json.scalar';
import { ActivityLoggingInterceptor } from './common/interceptors/activity-logging.interceptor';
import { winstonConfig } from './logger/winston.config';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { GraphQLLoggingPlugin } from './common/plugins/graphql-logging.plugin';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { GqlThrottlerGuard } from './auth/guards/gql-throttler.guard';
import {
  createThrottlerStorage,
  resolveThrottlerStorage,
} from './config/throttler-storage';
import { isOnlineMongoMode } from './common/utils/mongo-env.util';

@Module({
  imports: [
    // 1. Core Configurations
    ConfigModule.forRoot({ isGlobal: true }),
    WinstonModule.forRoot(winstonConfig),
    CacheModule.register({ isGlobal: true, ttl: 5 * 60 * 1000 }),
    // Cron/interval workers (GAP-H-014 quality-hold timeout sweep).
    ScheduleModule.forRoot(),
    // SEC-004/B2 — same limits as before; only the STORAGE changed.
    // resolveThrottlerStorage() throws at import time in production when
    // REDIS_URL is missing, so a misconfigured deploy never reaches listen().
    ThrottlerModule.forRoot({
      throttlers: [
        {
          ttl: 60000,
          limit: 100,
        },
      ],
      storage: createThrottlerStorage(resolveThrottlerStorage()),
    }),

    // 2. Database Connection

    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const isOnline = isOnlineMongoMode();
        const uri = configService.get<string>(
          isOnline ? 'MONGODB_URI_ONLINE' : 'MONGODB_URI_LOCAL',
        );

        return {
          uri,
          // DB-009 — index creation is a migration, not a deploy side effect.
          //
          // Mongoose defaults autoIndex to TRUE, so every boot issued
          // createIndexes() for all 45 schemas. On Render that runs on each
          // deploy and each autoscale event, against production data, with no
          // one watching — and a large build competes with live traffic for
          // exactly as long as it takes.
          //
          // Development keeps the default on purpose: a local database is
          // small, disposable, and nobody wants to run a migration to get a
          // working index while iterating on a schema.
          //
          // CONSEQUENCE, and it is not optional: with this off, a schema-
          // declared index is no longer built automatically in production.
          // Adding one to a schema now means adding it to a migration too.
          // See DB-011 in PROD-READINESS.md for the fresh-database case.
          autoIndex: process.env.NODE_ENV !== 'production',
          // Atlas requires TLS; local Docker Mongo connects in plaintext
          ...(isOnline && {
            tls: true,
            ssl: true,
            authSource: 'admin',
            retryWrites: true,
            w: 'majority',
          }),
          // This prevents the driver from getting stuck in an infinite topology check loop
          connectTimeoutMS: 10000,
          socketTimeoutMS: 45000,
        };
      },
      inject: [ConfigService],
    }),

    // 3. Security Foundations
    FirebaseModule,
    EmailModule,

    // 4. GraphQL Engine Integration
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
      sortSchema: true,
      playground: false,
      introspection: false,
      // SEC-003: Apollo defaults this to `NODE_ENV !== 'production'`, so any
      // deploy with NODE_ENV unset or set to something like 'staging' returns
      // full stack traces — absolute node_modules paths, internal file layout
      // — to unauthenticated clients. Pin it explicitly: on ONLY for a
      // developer machine, off for every other value including unset.
      includeStacktraceInErrorResponses: process.env.NODE_ENV === 'development',
      // Bound query nesting so an abusive/accidental deep query is rejected at
      // validation time, before it ever touches the resolvers or the database.
      validationRules: [depthLimit(10)],
      // Give expected failures an honest extensions.code. Without this Apollo
      // stamps INTERNAL_SERVER_ERROR on every uncoded error, so a 404
      // "not found" is indistinguishable from a real crash to both the client
      // and alerting. See format-error.ts.
      formatError: formatGraphQLError,
      context: ({ req, res }: { req: any; res: any }) => ({ req, res }),
    }),
    UsersModule,
    BranchesModule,
    DevicesModule,
    StaffModule,
    InventoryModule,
    ProductsModule,
    ServicesModule,
    PermissionsModule,
    RolesModule,
    PosOrdersModule,
    PosTransactionsModule,
    AnalyticsModule,
    ActivityLogsModule,
    TasksModule,
    CostingModule,
    WasherModule,
    MediaModule,
    BiometricModule,
    NotificationsModule,
    ConsentsModule,
    AddressesModule,
    WasherServiceTemplatesModule,
    WasherServiceOfferingsModule,
    WasherServiceProductsModule,
    OnlineOrdersModule,
    PlatformFeeModule,
    WalletsModule,
    AdminAuditModule,
    SupportTicketsModule,
    DirectoryModule,
    SearchModule,
    OperationalContextModule,
    NowQueueModule,
    PromotionsModule,
    CampaignsModule,
    PlatformAnalyticsModule,
    SiteContentModule,
    OrderDashboardModule,
    RatingsModule,
    DiscoveryModule,
    BookingPolicyModule,
    BookingAvailabilityModule,
    FavoritesModule,
    ChatModule,
    PresenceModule,
    KycModule,
    CourierVerificationModule,
    AccountDeletionModule,
    MaintenanceModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    AppResolver,
    JSONScalar,
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ActivityLoggingInterceptor },
    { provide: APP_GUARD, useClass: GqlThrottlerGuard },
    GraphQLLoggingPlugin,
  ],
})
export class AppModule {}
