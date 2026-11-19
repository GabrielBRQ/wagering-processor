import { Inject, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { InboxMessage } from '../../domain/entities/inbox-message.entity';
import { OutboxMessage } from '../../domain/entities/outbox-message.entity';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction.entity';
import { LedgerDirection } from '../../domain/entities/wallet-ledger-entry.entity';
import { Wallet } from '../../domain/entities/wallet.entity';
import {
  DomainRuleViolationError,
  FailureCode,
} from '../../domain/errors/domain.errors';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/integration-event';
import { Money, MoneyProps } from '../../domain/value-objects/money';
import { MetricsService } from '../../infrastructure/observability/metrics.service';
import { StructuredLogger } from '../../infrastructure/observability/structured-logger.service';
import {
  IdempotencyConflictError,
  NotFoundApplicationError,
  ValidationApplicationError,
} from '../errors/application.errors';
import type { TransactionContext, UnitOfWork } from '../ports/repositories.port';
import { computeWagerPayloadHash } from '../utils/canonical-hash';
import { UNIT_OF_WORK } from './wallet.use-cases';

export interface InboxContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface ProcessWagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  inboxContext?: InboxContext;
}

export interface WagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export interface WagerTransactionDetails {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  balance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

type ReferenceEvaluation =
  | { outcome: 'READY'; reference?: WagerTransaction }
  | { outcome: 'PENDING' }
  | { outcome: 'REJECT'; code: FailureCode };

@Injectable()
export class ProcessWagerTransactionUseCase {
  private readonly pendingRetryTracker = new Map<string, { attempts: number; nextDueAt: number }>();

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    private readonly logger: StructuredLogger,
    private readonly metrics: MetricsService,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<WagerTransactionResult> {
    const startedAt = performance.now();
    const correlationId = command.correlationId ?? uuidv4();
    const messageId = command.inboxContext?.messageId;

    this.validateCommandBasics(command);
    const money = Money.from(command.money);

    const payloadHash = computeWagerPayloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    try {
      const result = await this.uow.runInTransaction(async (ctx) => {
        const now = new Date();

        // 1. Deduplicação persistente via Inbox quando a entrada vem do SQS
        let inboxRecord: InboxMessage | undefined;
        if (command.inboxContext) {
          const existingInbox = await ctx.inbox.findByKey(
            command.inboxContext.consumerName,
            command.inboxContext.messageId,
          );
          if (existingInbox?.isProcessed()) {
            this.metrics.incrementDuplicates();
            const existingTx = await ctx.transactions.findByIdempotencyKey(command.idempotencyKey);
            if (existingTx) {
              return this.buildReplayResult(ctx, existingTx);
            }
          }
          inboxRecord =
            existingInbox ??
            InboxMessage.receive({
              consumerName: command.inboxContext.consumerName,
              messageId: command.inboxContext.messageId,
              payloadHash: command.inboxContext.payloadHash,
              receivedAt: now,
            });
        }

        // 2. Verificação rápida de idempotência antes do lock (detecta replay/conflito mesmo se walletId divergir)
        const preExistingByKey = await ctx.transactions.findByIdempotencyKey(
          command.idempotencyKey,
        );
        if (preExistingByKey) {
          return this.handleExistingTransaction(
            ctx,
            preExistingByKey,
            payloadHash,
            inboxRecord,
            now,
            correlationId,
            messageId,
          );
        }

        // 3. Serialização concorrente por walletId via Pessimistic Lock (SELECT ... FOR UPDATE)
        const wallet = await ctx.wallets.findByIdForUpdate(command.walletId);
        if (!wallet) {
          throw new NotFoundApplicationError('Wallet', command.walletId);
        }

        // 4. Re-checagem dentro do lock para garantir exclusividade após disputa paralela
        const lockedExistingByKey = await ctx.transactions.findByIdempotencyKey(
          command.idempotencyKey,
        );
        if (lockedExistingByKey) {
          return this.handleExistingTransaction(
            ctx,
            lockedExistingByKey,
            payloadHash,
            inboxRecord,
            now,
            correlationId,
            messageId,
          );
        }

        const lockedExistingByExternal = await ctx.transactions.findByProviderAndExternalId(
          command.providerId,
          command.externalTransactionId,
        );
        if (lockedExistingByExternal) {
          return this.handleExistingTransaction(
            ctx,
            lockedExistingByExternal,
            payloadHash,
            inboxRecord,
            now,
            correlationId,
            messageId,
          );
        }

        // 5. Criação da transação de domínio em PENDING
        const tx = WagerTransaction.create({
          id: uuidv4(),
          providerId: command.providerId,
          externalTransactionId: command.externalTransactionId,
          idempotencyKey: command.idempotencyKey,
          payloadHash,
          walletId: wallet.id,
          playerId: command.playerId,
          roundId: command.roundId,
          gameId: command.gameId,
          kind: command.kind,
          money,
          referenceExternalTransactionId: command.referenceExternalTransactionId,
          createdAt: now,
        });

        // 6. Validações de compatibilidade com a wallet (playerId e currency)
        if (wallet.playerId !== tx.playerId) {
          return this.rejectAndCommit(
            ctx,
            tx,
            wallet,
            FailureCode.PLAYER_WALLET_MISMATCH,
            inboxRecord,
            now,
            correlationId,
            messageId,
          );
        }

        if (wallet.currency !== tx.money.currency) {
          return this.rejectAndCommit(
            ctx,
            tx,
            wallet,
            FailureCode.WALLET_CURRENCY_MISMATCH,
            inboxRecord,
            now,
            correlationId,
            messageId,
          );
        }

        // 7. Resolução e validação de referência (REFUND, ROLLBACK ou WIN com referência)
        const refEval = await this.evaluateReference(ctx, tx);
        if (refEval.outcome === 'PENDING') {
          tx.markPendingReference();
          await ctx.transactions.save(tx);

          const pendingEvent = WagerTransactionPendingReference.from(tx, {
            eventId: uuidv4(),
            correlationId,
            causationId: tx.id,
            occurredAt: now,
          });
          await ctx.outbox.enqueue([OutboxMessage.enqueue(pendingEvent)]);

          if (inboxRecord) {
            inboxRecord.markProcessed(now);
            await ctx.inbox.save(inboxRecord);
          }

          this.metrics.incrementTransactionStatus(tx.status);
          this.logger.info('wager.transaction.pending_reference', {
            correlationId,
            messageId,
            transactionId: tx.id,
            walletId: wallet.id,
            providerId: tx.providerId,
          });

          return {
            transactionId: tx.id,
            status: tx.status,
            idempotentReplay: false,
          };
        }

        if (refEval.outcome === 'REJECT') {
          return this.rejectAndCommit(
            ctx,
            tx,
            wallet,
            refEval.code,
            inboxRecord,
            now,
            correlationId,
            messageId,
          );
        }

        // 8. Aplicação financeira atômica (Wallet + Ledger + Outbox + Inbox)
        return this.applyFinancialTransition(
          ctx,
          tx,
          wallet,
          refEval.reference,
          inboxRecord,
          now,
          correlationId,
          messageId,
        );
      });

      return result;
    } finally {
      this.metrics.recordProcessingLatency(performance.now() - startedAt);
    }
  }

  /**
   * Worker agendado (Seção 7.1): reprocessa transações em PENDING_REFERENCE com backoff exponencial e TTL.
   */
  async reprocessPendingReferences(ttlMs = 30_000, batchSize = 50): Promise<number> {
    const now = new Date();
    const nowMs = now.getTime();

    const candidates = await this.uow.runInTransaction((ctx) =>
      ctx.transactions.findDuePendingReferences(now, batchSize),
    );

    let resolvedCount = 0;

    for (const candidate of candidates) {
      const tracker = this.pendingRetryTracker.get(candidate.id);
      if (tracker && tracker.nextDueAt > nowMs) {
        continue;
      }

      const correlationId = uuidv4();

      await this.uow.runInTransaction(async (ctx) => {
        const wallet = await ctx.wallets.findByIdForUpdate(candidate.walletId);
        const tx = await ctx.transactions.findById(candidate.id);

        if (!tx || tx.status !== WagerTransactionStatus.PendingReference || !wallet) {
          this.pendingRetryTracker.delete(candidate.id);
          return;
        }

        const refEval = await this.evaluateReference(ctx, tx);

        if (refEval.outcome === 'READY') {
          await this.applyFinancialTransition(
            ctx,
            tx,
            wallet,
            refEval.reference,
            undefined,
            now,
            correlationId,
          );
          this.pendingRetryTracker.delete(tx.id);
          resolvedCount += 1;
          return;
        }

        if (refEval.outcome === 'REJECT') {
          await this.rejectAndCommit(
            ctx,
            tx,
            wallet,
            refEval.code,
            undefined,
            now,
            correlationId,
          );
          this.pendingRetryTracker.delete(tx.id);
          resolvedCount += 1;
          return;
        }

        // Ainda pendente: verifica se o TTL estourou
        const ageMs = nowMs - tx.createdAt.getTime();
        if (ageMs >= ttlMs) {
          await this.rejectAndCommit(
            ctx,
            tx,
            wallet,
            FailureCode.REFERENCE_NOT_FOUND,
            undefined,
            now,
            correlationId,
          );
          this.pendingRetryTracker.delete(tx.id);
          resolvedCount += 1;
          return;
        }

        // Agenda próxima verificação com backoff exponencial (500ms, 1s, 2s, 4s...)
        const attempts = (tracker?.attempts ?? 0) + 1;
        const backoffMs = Math.min(500 * Math.pow(2, attempts - 1), 10_000);
        this.pendingRetryTracker.set(tx.id, {
          attempts,
          nextDueAt: nowMs + backoffMs,
        });
        this.metrics.incrementRetries();
      });
    }

    return resolvedCount;
  }

  async getById(transactionId: string): Promise<WagerTransactionDetails> {
    return this.uow.runInTransaction(async (ctx) => {
      const tx = await ctx.transactions.findById(transactionId);
      if (!tx) {
        throw new NotFoundApplicationError('WagerTransaction', transactionId);
      }
      return this.toDetails(tx);
    });
  }

  async getByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionDetails> {
    return this.uow.runInTransaction(async (ctx) => {
      const tx = await ctx.transactions.findByProviderAndExternalId(
        providerId,
        externalTransactionId,
      );
      if (!tx) {
        throw new NotFoundApplicationError(
          'WagerTransaction',
          `${providerId}:${externalTransactionId}`,
        );
      }
      return this.toDetails(tx);
    });
  }

  private validateCommandBasics(command: ProcessWagerTransactionCommand): void {
    if (
      !command.providerId?.trim() ||
      !command.externalTransactionId?.trim() ||
      !command.idempotencyKey?.trim() ||
      !command.playerId?.trim() ||
      !command.walletId?.trim() ||
      !command.roundId?.trim() ||
      !command.gameId?.trim()
    ) {
      throw new ValidationApplicationError('Missing required transaction fields');
    }

    if (command.kind === WagerTransactionKind.Opening) {
      throw new ValidationApplicationError(
        'OPENING transactions are internal and cannot be submitted externally',
      );
    }

    if (
      (command.kind === WagerTransactionKind.Refund ||
        command.kind === WagerTransactionKind.Rollback) &&
      !command.referenceExternalTransactionId?.trim()
    ) {
      throw new ValidationApplicationError(
        `Transaction kind ${command.kind} requires referenceExternalTransactionId`,
      );
    }
  }

  private async handleExistingTransaction(
    ctx: TransactionContext,
    existing: WagerTransaction,
    payloadHash: string,
    inboxRecord: InboxMessage | undefined,
    now: Date,
    correlationId: string,
    messageId?: string,
  ): Promise<WagerTransactionResult> {
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(existing.idempotencyKey);
    }

    if (inboxRecord && !inboxRecord.isProcessed()) {
      inboxRecord.markProcessed(now);
      await ctx.inbox.save(inboxRecord);
    }

    this.metrics.incrementDuplicates();
    this.logger.info('wager.transaction.idempotent_replay', {
      correlationId,
      messageId,
      transactionId: existing.id,
      walletId: existing.walletId,
      providerId: existing.providerId,
    });

    return this.buildReplayResult(ctx, existing);
  }

  private async buildReplayResult(
    ctx: TransactionContext,
    tx: WagerTransaction,
  ): Promise<WagerTransactionResult> {
    let balance = tx.balanceAfter?.toJSON();
    if (!balance && tx.status !== WagerTransactionStatus.PendingReference) {
      const wallet = await ctx.wallets.findById(tx.walletId);
      balance = wallet?.balance.toJSON();
    }

    return {
      transactionId: tx.id,
      status: tx.status,
      ...(balance ? { balance } : {}),
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
      idempotentReplay: true,
    };
  }

  private async evaluateReference(
    ctx: TransactionContext,
    tx: WagerTransaction,
  ): Promise<ReferenceEvaluation> {
    const needsLookup = tx.requiresReference() || Boolean(tx.referenceExternalTransactionId);
    if (!needsLookup || !tx.referenceExternalTransactionId) {
      return { outcome: 'READY' };
    }

    const reference = await ctx.transactions.findByProviderAndExternalId(
      tx.providerId,
      tx.referenceExternalTransactionId,
    );

    if (!reference) {
      return { outcome: 'PENDING' };
    }

    if (
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference
    ) {
      return { outcome: 'PENDING' };
    }

    if (reference.status !== WagerTransactionStatus.Processed) {
      return { outcome: 'REJECT', code: FailureCode.INVALID_REFERENCE_STATUS };
    }

    // Regra 2: mesmo provider, player, wallet, moeda e rodada
    if (
      reference.providerId !== tx.providerId ||
      reference.playerId !== tx.playerId ||
      reference.walletId !== tx.walletId ||
      reference.money.currency !== tx.money.currency ||
      reference.roundId !== tx.roundId
    ) {
      return { outcome: 'REJECT', code: FailureCode.REFERENCE_MISMATCH };
    }

    // Regra 3: REFUND só referencia BET; ROLLBACK referencia BET, WIN ou REFUND; WIN opcionalmente referencia BET
    if (tx.kind === WagerTransactionKind.Refund && reference.kind !== WagerTransactionKind.Bet) {
      return { outcome: 'REJECT', code: FailureCode.INVALID_REFERENCE_KIND };
    }

    if (
      tx.kind === WagerTransactionKind.Rollback &&
      reference.kind !== WagerTransactionKind.Bet &&
      reference.kind !== WagerTransactionKind.Win &&
      reference.kind !== WagerTransactionKind.Refund
    ) {
      return { outcome: 'REJECT', code: FailureCode.INVALID_REFERENCE_KIND };
    }

    if (tx.kind === WagerTransactionKind.Win && reference.kind !== WagerTransactionKind.Bet) {
      return { outcome: 'REJECT', code: FailureCode.INVALID_REFERENCE_KIND };
    }

    // Regras 4 e 5: reversão única e valor exato
    if (tx.requiresReference()) {
      const alreadyReversed = await ctx.transactions.hasProcessedReversalFor(reference.id);
      if (alreadyReversed) {
        return { outcome: 'REJECT', code: FailureCode.ALREADY_REVERSED };
      }

      if (!tx.money.equals(reference.money)) {
        return { outcome: 'REJECT', code: FailureCode.AMOUNT_MISMATCH };
      }
    }

    return { outcome: 'READY', reference };
  }

  private async applyFinancialTransition(
    ctx: TransactionContext,
    tx: WagerTransaction,
    wallet: Wallet,
    reference: WagerTransaction | undefined,
    inboxRecord: InboxMessage | undefined,
    now: Date,
    correlationId: string,
    messageId?: string,
  ): Promise<WagerTransactionResult> {
    if (!tx.affectsBalance()) {
      // LOSS: registra resultado sem alterar saldo nem gerar ledger
      tx.markProcessed(reference?.id, now, wallet.balance);
      await ctx.transactions.save(tx);

      const processedEvent = WagerTransactionProcessed.from(tx, {
        eventId: uuidv4(),
        correlationId,
        causationId: tx.id,
        occurredAt: now,
      });
      await ctx.outbox.enqueue([OutboxMessage.enqueue(processedEvent)]);

      if (inboxRecord) {
        inboxRecord.markProcessed(now);
        await ctx.inbox.save(inboxRecord);
      }

      this.metrics.incrementTransactionStatus(tx.status);
      this.logger.info('wager.transaction.processed', {
        correlationId,
        messageId,
        transactionId: tx.id,
        walletId: wallet.id,
        providerId: tx.providerId,
      });

      return {
        transactionId: tx.id,
        status: tx.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    }

    const direction = tx.ledgerDirectionFor(reference);

    if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(tx.money)) {
      const failureCode =
        tx.kind === WagerTransactionKind.Rollback || tx.kind === WagerTransactionKind.Refund
          ? FailureCode.REVERSAL_INSUFFICIENT_FUNDS
          : FailureCode.INSUFFICIENT_FUNDS;

      return this.rejectAndCommit(
        ctx,
        tx,
        wallet,
        failureCode,
        inboxRecord,
        now,
        correlationId,
        messageId,
      );
    }

    const ledgerEntry =
      direction === LedgerDirection.Debit
        ? wallet.debit({
            entryId: uuidv4(),
            transactionId: tx.id,
            money: tx.money,
            at: now,
          })
        : wallet.credit({
            entryId: uuidv4(),
            transactionId: tx.id,
            money: tx.money,
            at: now,
          });

    tx.markProcessed(reference?.id, now, wallet.balance);

    await ctx.wallets.save(wallet);
    await ctx.transactions.save(tx);
    await ctx.ledger.append(ledgerEntry);

    const balanceEvent = WalletBalanceChanged.from(wallet, ledgerEntry, {
      eventId: uuidv4(),
      correlationId,
      causationId: tx.id,
      occurredAt: now,
    });

    const processedEvent = WagerTransactionProcessed.from(tx, {
      eventId: uuidv4(),
      correlationId,
      causationId: tx.id,
      occurredAt: now,
    });

    await ctx.outbox.enqueue([
      OutboxMessage.enqueue(balanceEvent),
      OutboxMessage.enqueue(processedEvent),
    ]);

    if (inboxRecord) {
      inboxRecord.markProcessed(now);
      await ctx.inbox.save(inboxRecord);
    }

    this.metrics.incrementTransactionStatus(tx.status);
    this.logger.info('wager.transaction.processed', {
      correlationId,
      messageId,
      transactionId: tx.id,
      walletId: wallet.id,
      providerId: tx.providerId,
    });

    return {
      transactionId: tx.id,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private async rejectAndCommit(
    ctx: TransactionContext,
    tx: WagerTransaction,
    wallet: Wallet,
    failureCode: FailureCode,
    inboxRecord: InboxMessage | undefined,
    now: Date,
    correlationId: string,
    messageId?: string,
  ): Promise<WagerTransactionResult> {
    tx.reject(failureCode, wallet.balance);
    await ctx.transactions.save(tx);

    const rejectedEvent = WagerTransactionRejected.from(tx, {
      eventId: uuidv4(),
      correlationId,
      causationId: tx.id,
      occurredAt: now,
    });
    await ctx.outbox.enqueue([OutboxMessage.enqueue(rejectedEvent)]);

    if (inboxRecord) {
      inboxRecord.markProcessed(now);
      await ctx.inbox.save(inboxRecord);
    }

    this.metrics.incrementTransactionStatus(tx.status);
    this.logger.warn('wager.transaction.rejected', {
      correlationId,
      messageId,
      transactionId: tx.id,
      walletId: wallet.id,
      providerId: tx.providerId,
      failureCode,
    });

    return {
      transactionId: tx.id,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      failureCode,
      idempotentReplay: false,
    };
  }

  private toDetails(tx: WagerTransaction): WagerTransactionDetails {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      status: tx.status,
      money: tx.money.toJSON(),
      ...(tx.referenceExternalTransactionId
        ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
        : {}),
      ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
      ...(tx.balanceAfter ? { balance: tx.balanceAfter.toJSON() } : {}),
      createdAt: tx.createdAt.toISOString(),
      ...(tx.processedAt ? { processedAt: tx.processedAt.toISOString() } : {}),
    };
  }
}