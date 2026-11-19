import { Inject, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { WagerTransaction } from '../../domain/entities/wager-transaction.entity';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry.entity';
import { OutboxMessage } from '../../domain/entities/outbox-message.entity';
import { Wallet } from '../../domain/entities/wallet.entity';
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from '../../domain/events/integration-event';
import { Money, MoneyProps } from '../../domain/value-objects/money';
import { MetricsService } from '../../infrastructure/observability/metrics.service';
import { StructuredLogger } from '../../infrastructure/observability/structured-logger.service';
import {
  NotFoundApplicationError,
  ValidationApplicationError,
  WalletConflictError,
} from '../errors/application.errors';
import type { UnitOfWork } from '../ports/repositories.port';

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId?: string;
}

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerEntryResponse {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface WalletLedgerResponse {
  walletId: string;
  entries: LedgerEntryResponse[];
  nextCursor: string | null;
}

export interface ReconciliationResponse {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class WalletUseCases {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    private readonly logger: StructuredLogger,
    private readonly metrics: MetricsService,
  ) {}

  async createWallet(command: CreateWalletCommand): Promise<WalletResponse> {
    if (!command.playerId?.trim()) {
      throw new ValidationApplicationError('playerId is required');
    }

    const initialBalance = Money.from(command.initialBalance);
    const correlationId = command.correlationId ?? uuidv4();
    const now = new Date();

    try {
      return await this.uow.runInTransaction(async (ctx) => {
        const existing = await ctx.wallets.findByPlayerAndCurrency(
          command.playerId,
          initialBalance.currency,
        );
        if (existing) {
          throw new WalletConflictError(command.playerId, initialBalance.currency);
        }

        const wallet = Wallet.open({
          id: uuidv4(),
          playerId: command.playerId,
          initialBalance,
          createdAt: now,
        });

        await ctx.wallets.save(wallet);

        if (initialBalance.isPositive()) {
          const openingTx = WagerTransaction.createOpening({
            id: uuidv4(),
            walletId: wallet.id,
            playerId: wallet.playerId,
            money: initialBalance,
            createdAt: now,
          });

          const openingEntry = WalletLedgerEntry.create({
            id: uuidv4(),
            walletId: wallet.id,
            transactionId: openingTx.id,
            direction: LedgerDirection.Credit,
            money: initialBalance,
            balanceBefore: Money.zero(initialBalance.currency),
            balanceAfter: initialBalance,
            createdAt: now,
          });

          await ctx.transactions.save(openingTx);
          await ctx.ledger.append(openingEntry);

          const balanceEvent = WalletBalanceChanged.from(wallet, openingEntry, {
            eventId: uuidv4(),
            correlationId,
            causationId: openingTx.id,
            occurredAt: now,
          });

          const txEvent = WagerTransactionProcessed.from(openingTx, {
            eventId: uuidv4(),
            correlationId,
            causationId: openingTx.id,
            occurredAt: now,
          });

          await ctx.outbox.enqueue([
            OutboxMessage.enqueue(balanceEvent),
            OutboxMessage.enqueue(txEvent),
          ]);
        }

        this.logger.info('wallet.created', {
          correlationId,
          walletId: wallet.id,
        });

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new WalletConflictError(command.playerId, initialBalance.currency);
      }
      throw error;
    }
  }

  async getWallet(walletId: string): Promise<WalletResponse> {
    return this.uow.runInTransaction(async (ctx) => {
      const wallet = await ctx.wallets.findById(walletId);
      if (!wallet) {
        throw new NotFoundApplicationError('Wallet', walletId);
      }
      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }

  async getWalletLedger(
    walletId: string,
    cursor?: string,
    limit = 50,
  ): Promise<WalletLedgerResponse> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ValidationApplicationError('limit must be an integer between 1 and 100');
    }

    return this.uow.runInTransaction(async (ctx) => {
      const wallet = await ctx.wallets.findById(walletId);
      if (!wallet) {
        throw new NotFoundApplicationError('Wallet', walletId);
      }

      try {
        const page = await ctx.ledger.findByWalletPaginated(walletId, cursor, limit);
        return {
          walletId,
          entries: page.entries.map((entry) => ({
            id: entry.id,
            transactionId: entry.transactionId,
            direction: entry.direction,
            money: entry.money.toJSON(),
            balanceBefore: entry.balanceBefore.toJSON(),
            balanceAfter: entry.balanceAfter.toJSON(),
            createdAt: entry.createdAt.toISOString(),
          })),
          nextCursor: page.nextCursor,
        };
      } catch (error) {
        if (error instanceof Error && error.message === 'INVALID_CURSOR') {
          throw new ValidationApplicationError('Invalid pagination cursor');
        }
        throw error;
      }
    });
  }

  async reconcileWallet(walletId: string, correlationId?: string): Promise<ReconciliationResponse> {
    const corrId = correlationId ?? uuidv4();

    return this.uow.runInTransaction(async (ctx) => {
      const wallet = await ctx.wallets.findById(walletId);
      if (!wallet) {
        throw new NotFoundApplicationError('Wallet', walletId);
      }

      const entries = await ctx.ledger.findAllByWallet(walletId);
      let calculated = Money.zero(wallet.currency);

      for (const entry of entries) {
        calculated =
          entry.direction === LedgerDirection.Credit
            ? calculated.add(entry.money)
            : calculated.subtract(entry.money);
      }

      const stored = wallet.balance;
      const difference = stored.subtract(calculated);
      const consistent = difference.isZero();

      if (!consistent) {
        this.metrics.incrementReconciliationDiscrepancies();
        this.logger.warn('wallet.reconciliation.discrepancy', {
          correlationId: corrId,
          walletId,
          checkedEntries: entries.length,
        });
      } else {
        this.logger.info('wallet.reconciliation.ok', {
          correlationId: corrId,
          walletId,
          checkedEntries: entries.length,
        });
      }

      return {
        walletId,
        storedBalance: stored.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: entries.length,
      };
    });
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as { code?: string; cause?: { code?: string } };
  return err.code === '23505' || err.cause?.code === '23505';
}