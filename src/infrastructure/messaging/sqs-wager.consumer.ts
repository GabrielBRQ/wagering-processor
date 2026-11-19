import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  IdempotencyConflictError,
  NotFoundApplicationError,
  ValidationApplicationError,
} from '../../application/errors/application.errors';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import { computeCanonicalHash } from '../../application/utils/canonical-hash';
import { WagerTransactionKind } from '../../domain/entities/wager-transaction.entity';
import { DomainError } from '../../domain/errors/domain.errors';
import { MoneyProps } from '../../domain/value-objects/money';
import { MetricsService } from '../observability/metrics.service';
import { StructuredLogger } from '../observability/structured-logger.service';
import { SqsGateway } from './sqs-client.provider';

interface SqsWagerEnvelope {
  messageId?: string;
  type?: string;
  occurredAt?: string;
  data?: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey?: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: MoneyProps;
    referenceExternalTransactionId?: string;
  };
}

const CONSUMER_NAME = 'sqs-wager-consumer';
const MAX_DELIVERY_ATTEMPTS = 5;

@Injectable()
export class SqsWagerConsumer implements OnModuleInit, OnModuleDestroy {
  private isStopping = false;
  private loopPromise: Promise<void> | null = null;
  private inFlightWork: Promise<void> | null = null;

  constructor(
    private readonly sqs: SqsGateway,
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly logger: StructuredLogger,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (process.env.DISABLE_SQS_CONSUMER === 'true') {
      return;
    }
    this.loopPromise = this.pollLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.isStopping = true;
    if (this.inFlightWork) {
      await this.inFlightWork;
    }
    if (this.loopPromise) {
      await this.loopPromise;
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.isStopping) {
      try {
        const response = await this.sqs.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.sqs.queueUrl,
            MaxNumberOfMessages: 5,
            WaitTimeSeconds: 2,
            VisibilityTimeout: 30,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
        );

        const messages = response.Messages ?? [];
        for (const msg of messages) {
          if (this.isStopping) {
            await this.releaseVisibility(msg);
            continue;
          }

          this.inFlightWork = this.handleMessage(msg);
          await this.inFlightWork;
          this.inFlightWork = null;
        }
      } catch (error) {
        if (!this.isStopping) {
          this.logger.error('sqs.consumer.poll_error', {}, error);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
  }

  async handleMessage(message: Message): Promise<void> {
    const receiptHandle = message.ReceiptHandle;
    const rawBody = message.Body ?? '';
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');

    let envelope: SqsWagerEnvelope;
    try {
      envelope = JSON.parse(rawBody) as SqsWagerEnvelope;
    } catch {
      await this.sendToDlqAndAck(message, 'MALFORMED_JSON');
      return;
    }

    // Ignora eventos de saída publicados pela Outbox na mesma fila
    if (!envelope.type && 'eventType' in envelope) {
      if (receiptHandle) {
        await this.ack(receiptHandle);
      }
      return;
    }

    if (envelope.type !== 'WagerTransactionRequested' || !envelope.data) {
      await this.sendToDlqAndAck(message, 'UNSUPPORTED_MESSAGE_TYPE');
      return;
    }

    const messageId = envelope.messageId ?? message.MessageId ?? 'unknown';
    const data = envelope.data;
    const idempotencyKey =
      data.idempotencyKey?.trim() || `${data.providerId}:${data.externalTransactionId}`;

    try {
      await this.processWagerUseCase.execute({
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        idempotencyKey,
        playerId: data.playerId,
        walletId: data.walletId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind,
        money: data.money,
        referenceExternalTransactionId: data.referenceExternalTransactionId,
        correlationId: messageId,
        inboxContext: {
          consumerName: CONSUMER_NAME,
          messageId,
          payloadHash: computeCanonicalHash(data),
        },
      });

      // ACK somente após commit bem-sucedido no banco
      if (receiptHandle) {
        await this.ack(receiptHandle);
      }
    } catch (error) {
      // Erros permanentes de contrato/domínio/conflito -> envia para DLQ e faz ACK
      if (
        error instanceof ValidationApplicationError ||
        error instanceof DomainError ||
        error instanceof IdempotencyConflictError ||
        error instanceof NotFoundApplicationError
      ) {
        this.logger.warn('sqs.consumer.permanent_error_to_dlq', {
          messageId,
          providerId: data.providerId,
          walletId: data.walletId,
          reason: error.message,
        });
        await this.sendToDlqAndAck(message, error.message);
        return;
      }

      // Erros transitórios (ex: falha temporária de Postgres) -> backoff exponencial ou DLQ
      this.metrics.incrementRetries();
      if (receiveCount >= MAX_DELIVERY_ATTEMPTS) {
        await this.sendToDlqAndAck(message, 'MAX_RETRIES_EXCEEDED');
        return;
      }

      if (receiptHandle) {
        const backoffSeconds = Math.min(Math.pow(2, receiveCount), 30);
        await this.sqs.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.sqs.queueUrl,
            ReceiptHandle: receiptHandle,
            VisibilityTimeout: backoffSeconds,
          }),
        );
      }

      this.logger.warn('sqs.consumer.transient_retry', {
        messageId,
        receiveCount,
      });
    }
  }

  private async ack(receiptHandle: string): Promise<void> {
    await this.sqs.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.sqs.queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  private async releaseVisibility(message: Message): Promise<void> {
    if (!message.ReceiptHandle) {
      return;
    }
    try {
      await this.sqs.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.sqs.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
    } catch {
      // ignora erro no shutdown
    }
  }

  private async sendToDlqAndAck(message: Message, reason: string): Promise<void> {
    this.metrics.incrementDlq();
    await this.sqs.client.send(
      new SendMessageCommand({
        QueueUrl: this.sqs.dlqUrl,
        MessageBody: message.Body ?? '{}',
        MessageGroupId: 'dlq',
        MessageDeduplicationId: `${message.MessageId ?? Date.now()}-${Date.now()}`,
        MessageAttributes: {
          FailureReason: {
            DataType: 'String',
            StringValue: reason.slice(0, 250),
          },
        },
      }),
    );

    if (message.ReceiptHandle) {
      await this.ack(message.ReceiptHandle);
    }
  }
}