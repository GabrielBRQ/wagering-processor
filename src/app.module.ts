import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { mikroOrmOptions } from './infrastructure/database/mikro-orm.options';
import { ProcessWagerTransactionUseCase } from './application/use-cases/process-wager-transaction.use-case';
import { UNIT_OF_WORK, WalletUseCases } from './application/use-cases/wallet.use-cases';
import { MikroOrmUnitOfWork } from './infrastructure/database/repositories/mikro-orm-repositories';
import { OutboxPublisherWorker } from './infrastructure/messaging/outbox-publisher.worker';
import { SqsGateway } from './infrastructure/messaging/sqs-client.provider';
import { SqsWagerConsumer } from './infrastructure/messaging/sqs-wager.consumer';
import { MetricsService } from './infrastructure/observability/metrics.service';
import { StructuredLogger } from './infrastructure/observability/structured-logger.service';
import { HealthController } from './presentation/controllers/health.controller';
import { WageringController } from './presentation/controllers/wagering.controller';
import { WalletsController } from './presentation/controllers/wallets.controller';
import { GlobalHttpExceptionFilter } from './presentation/filters/http-exception.filter';
import { ProviderAuthGuard } from './presentation/guards/provider-auth.guard';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      ...mikroOrmOptions,
      autoLoadEntities: false,
    }),
  ],
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    StructuredLogger,
    MetricsService,
    SqsGateway,
    MikroOrmUnitOfWork,
    {
      provide: UNIT_OF_WORK,
      useExisting: MikroOrmUnitOfWork,
    },
    WalletUseCases,
    ProcessWagerTransactionUseCase,
    OutboxPublisherWorker,
    SqsWagerConsumer,
    {
      provide: APP_GUARD,
      useClass: ProviderAuthGuard,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalHttpExceptionFilter,
    },
  ],
})
export class AppModule {}