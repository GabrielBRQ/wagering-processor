import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { UNIT_OF_WORK } from '../../application/use-cases/wallet.use-cases';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import type { UnitOfWork } from '../../application/ports/repositories.port';
import { MetricsService } from '../observability/metrics.service';
import { StructuredLogger } from '../observability/structured-logger.service';
import { SqsGateway } from './sqs-client.provider';

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private isRunning = false;
  private isStopping = false;
  private inFlightPromise: Promise<void> | null = null;

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    private readonly sqs: SqsGateway,
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly logger: StructuredLogger,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    const intervalMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 500);
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.isStopping = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    if (this.inFlightPromise) {
      await this.inFlightPromise;
    }
  }

  async tick(): Promise<void> {
    if (this.isRunning || this.isStopping) {
      return;
    }
    this.isRunning = true;

    const cycle = async () => {
      try {
        await this.publishDueBatch();
        const ttlMs = Number(process.env.PENDING_REFERENCE_TTL_MS ?? 30_000);
        await this.processWagerUseCase.reprocessPendingReferences(ttlMs, 50);
      } catch (error) {
        this.logger.error('outbox.worker.cycle_failed', {}, error);
      } finally {
        this.isRunning = false;
      }
    };

    this.inFlightPromise = cycle();
    await this.inFlightPromise;
    this.inFlightPromise = null;
  }

  async publishDueBatch(batchSize = 50): Promise<number> {
    const now = new Date();
    let publishedCount = 0;

    await this.uow.runInTransaction(async (ctx) => {
      const batch = await ctx.outbox.claimDueBatch(now, batchSize);

      for (const message of batch) {
        try {
          await this.sqs.client.send(
            new SendMessageCommand({
              QueueUrl: this.sqs.queueUrl,
              MessageBody: JSON.stringify(message.payload),
              MessageGroupId: message.aggregateId,
              MessageDeduplicationId: message.id,
            }),
          );

          message.markPublished(new Date());
          publishedCount += 1;
        } catch (error) {
          message.scheduleRetry(new Date());
          this.metrics.incrementRetries();
          this.logger.warn('outbox.publish.retry_scheduled', {
            eventId: message.id,
            eventType: message.eventType,
            attempts: message.attempts,
          });
        }

        await ctx.outbox.save(message);
      }

      const lagSeconds = await ctx.outbox.oldestPendingAgeSeconds(new Date());
      this.metrics.setOutboxLagSeconds(lagSeconds);
    });

    return publishedCount;
  }
}