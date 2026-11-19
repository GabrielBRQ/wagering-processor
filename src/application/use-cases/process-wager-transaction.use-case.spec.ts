import { describe, expect, it } from 'bun:test';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction.entity';
import { Wallet } from '../../domain/entities/wallet.entity';
import { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry.entity';
import { FailureCode } from '../../domain/errors/domain.errors';
import { Money } from '../../domain/value-objects/money';
import { MetricsService } from '../../infrastructure/observability/metrics.service';
import type { StructuredLogger } from '../../infrastructure/observability/structured-logger.service';
import { IdempotencyConflictError } from '../errors/application.errors';
import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  TransactionContext,
  UnitOfWork,
  WagerTransactionRepository,
  WalletRepository,
} from '../ports/repositories.port';
import { computeWagerPayloadHash } from '../utils/canonical-hash';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case';

function createInMemoryHarness(initialBalance = '100.00') {
  const wallets = new Map<string, Wallet>();
  const transactions = new Map<string, any>();
  const ledgerEntries: WalletLedgerEntry[] = [];
  const outboxMessages: any[] = [];

  const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
  const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

  wallets.set(
    walletId,
    Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.from({ amount: initialBalance, currency: 'BRL' }),
    }),
  );

  const walletRepo: WalletRepository = {
    async findById(id) {
      return wallets.get(id) ?? null;
    },
    async findByIdForUpdate(id) {
      return wallets.get(id) ?? null;
    },
    async findByPlayerAndCurrency(pId, currency) {
      for (const w of wallets.values()) {
        if (w.playerId === pId && w.currency === currency) return w;
      }
      return null;
    },
    async save(wallet) {
      wallets.set(wallet.id, wallet);
    },
  };

  const txRepo: WagerTransactionRepository = {
    async findById(id) {
      return transactions.get(id) ?? null;
    },
    async findByIdempotencyKey(key) {
      for (const tx of transactions.values()) {
        if (tx.idempotencyKey === key) return tx;
      }
      return null;
    },
    async findByProviderAndExternalId(providerId, externalTransactionId) {
      for (const tx of transactions.values()) {
        if (
          tx.providerId === providerId &&
          tx.externalTransactionId === externalTransactionId
        ) {
          return tx;
        }
      }
      return null;
    },
    async hasProcessedReversalFor(referenceTransactionId) {
      for (const tx of transactions.values()) {
        if (
          tx.referenceTransactionId === referenceTransactionId &&
          tx.status === WagerTransactionStatus.Processed &&
          (tx.kind === WagerTransactionKind.Refund ||
            tx.kind === WagerTransactionKind.Rollback)
        ) {
          return true;
        }
      }
      return false;
    },
    async findDuePendingReferences() {
      return [];
    },
    async save(tx) {
      transactions.set(tx.id, tx);
    },
  };

  const ledgerRepo: LedgerRepository = {
    async append(entry) {
      ledgerEntries.push(entry);
    },
    async findByWalletPaginated(wId) {
      const entries = ledgerEntries.filter((e) => e.walletId === wId);
      return { entries, nextCursor: null };
    },
    async findAllByWallet(wId) {
      return ledgerEntries.filter((e) => e.walletId === wId);
    },
  };

  const inboxRepo: InboxRepository = {
    async findByKey() {
      return null;
    },
    async save() {},
  };

  const outboxRepo: OutboxRepository = {
    async enqueue(messages) {
      outboxMessages.push(...messages);
    },
    async claimDueBatch() {
      return [];
    },
    async save() {},
    async countPending() {
      return outboxMessages.length;
    },
    async oldestPendingAgeSeconds() {
      return 0;
    },
  };

  const uow: UnitOfWork = {
    async runInTransaction<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T> {
      return work({
        wallets: walletRepo,
        transactions: txRepo,
        ledger: ledgerRepo,
        inbox: inboxRepo,
        outbox: outboxRepo,
      });
    },
  };

  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as StructuredLogger;

  const metrics = new MetricsService();
  const useCase = new ProcessWagerTransactionUseCase(uow, logger, metrics);

  return { useCase, wallets, ledgerEntries, outboxMessages, walletId, playerId };
}

describe('ProcessWagerTransactionUseCase (Unit)', () => {
  it('lança IdempotencyConflictError quando a mesma Idempotency-Key é enviada com payload divergente', async () => {
    const { useCase, walletId, playerId } = createInMemoryHarness('100.00');

    const baseCommand = {
      providerId: 'provider-a',
      externalTransactionId: 'tx-1',
      idempotencyKey: 'provider-a:tx-1',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    };

    const first = await useCase.execute(baseCommand);
    expect(first.status).toBe(WagerTransactionStatus.Processed);
    expect(first.idempotentReplay).toBe(false);

    await expect(
      useCase.execute({
        ...baseCommand,
        money: { amount: '50.00', currency: 'BRL' },
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('retorna idempotentReplay=true com o saldo observado originalmente ao repetir requisição idêntica', async () => {
    const { useCase, walletId, playerId } = createInMemoryHarness('100.00');

    const first = await useCase.execute({
      providerId: 'provider-a',
      externalTransactionId: 'tx-1',
      idempotencyKey: 'provider-a:tx-1',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(first.balance?.amount).toBe('75.00');

    // Segunda transação altera o saldo atual da carteira para 55.00
    await useCase.execute({
      providerId: 'provider-a',
      externalTransactionId: 'tx-2',
      idempotencyKey: 'provider-a:tx-2',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '20.00', currency: 'BRL' },
    });

    // Replay da primeira aposta devolve 75.00 (saldo observado naquele momento)
    const replay = await useCase.execute({
      providerId: 'provider-a',
      externalTransactionId: 'tx-1',
      idempotencyKey: 'provider-a:tx-1',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    });

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance?.amount).toBe('75.00');
  });

  it('rejeita ROLLBACK de WIN sem saldo com REVERSAL_INSUFFICIENT_FUNDS sem alterar saldo ou ledger', async () => {
    const { useCase, wallets, ledgerEntries, walletId, playerId } = createInMemoryHarness('0.00');

    await useCase.execute({
      providerId: 'provider-a',
      externalTransactionId: 'win-1',
      idempotencyKey: 'provider-a:win-1',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Win,
      money: { amount: '50.00', currency: 'BRL' },
    });

    await useCase.execute({
      providerId: 'provider-a',
      externalTransactionId: 'bet-spend',
      idempotencyKey: 'provider-a:bet-spend',
      playerId,
      walletId,
      roundId: 'round-2',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '50.00', currency: 'BRL' },
    });

    const ledgerCountBefore = ledgerEntries.length;

    const rollback = await useCase.execute({
      providerId: 'provider-a',
      externalTransactionId: 'rb-1',
      idempotencyKey: 'provider-a:rb-1',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: 'win-1',
    });

    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.REVERSAL_INSUFFICIENT_FUNDS);
    expect(wallets.get(walletId)?.balance.amount).toBe('0.00');
    expect(ledgerEntries.length).toBe(ledgerCountBefore);
  });

  it('rejeita operação com moeda diferente da carteira sem movimentar saldo', async () => {
    const { useCase, wallets, ledgerEntries, walletId, playerId } = createInMemoryHarness('100.00');

    const result = await useCase.execute({
      providerId: 'provider-a',
      externalTransactionId: 'tx-usd',
      idempotencyKey: 'provider-a:tx-usd',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'USD' },
    });

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.WALLET_CURRENCY_MISMATCH);
    expect(wallets.get(walletId)?.balance.amount).toBe('100.00');
    expect(ledgerEntries.length).toBe(0);
  });

  it('calcula hash canônico idêntico independente da ordem das chaves', () => {
    const h1 = computeWagerPayloadHash({
      providerId: 'provider-a',
      externalTransactionId: 'tx-99',
      playerId: 'p1',
      walletId: 'w1',
      roundId: 'r1',
      gameId: 'g1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    });

    const h2 = computeWagerPayloadHash({
      kind: WagerTransactionKind.Bet,
      money: { currency: 'BRL', amount: '10.00' },
      gameId: 'g1',
      roundId: 'r1',
      walletId: 'w1',
      playerId: 'p1',
      externalTransactionId: 'tx-99',
      providerId: 'provider-a',
    });

    expect(h1).toBe(h2);
  });
});