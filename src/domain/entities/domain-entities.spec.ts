import { describe, expect, it } from 'bun:test';
import {
  CurrencyMismatchError,
  DomainRuleViolationError,
  FailureCode,
  InsufficientBalanceError,
  InvalidLedgerEntryError,
  InvalidTransactionStateError,
} from '../errors/domain.errors';
import { Money } from '../value-objects/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.entity';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.entity';
import { Wallet } from './wallet.entity';

describe('Wallet & WalletLedgerEntry', () => {
  it('opens wallet at version 1 and tracks debits/credits with balanced ledger entries', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('100.00');

    const debitEntry = wallet.debit({
      entryId: 'entry-1',
      transactionId: 'tx-1',
      money: Money.from({ amount: '35.50', currency: 'BRL' }),
    });

    expect(wallet.balance.amount).toBe('64.50');
    expect(wallet.version).toBe(2);
    expect(debitEntry.isBalanced()).toBe(true);
    expect(debitEntry.balanceBefore.amount).toBe('100.00');
    expect(debitEntry.balanceAfter.amount).toBe('64.50');

    const creditEntry = wallet.credit({
      entryId: 'entry-2',
      transactionId: 'tx-2',
      money: Money.from({ amount: '15.50', currency: 'BRL' }),
    });

    expect(wallet.balance.amount).toBe('80.00');
    expect(wallet.version).toBe(3);
    expect(creditEntry.isBalanced()).toBe(true);
  });

  it('prevents negative balance and currency mismatch on wallet operations', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    expect(() =>
      wallet.debit({
        entryId: 'entry-1',
        transactionId: 'tx-1',
        money: Money.from({ amount: '80.00', currency: 'BRL' }),
      }),
    ).toThrow(InsufficientBalanceError);

    expect(wallet.balance.amount).toBe('50.00');
    expect(wallet.version).toBe(1);

    expect(() =>
      wallet.credit({
        entryId: 'entry-2',
        transactionId: 'tx-2',
        money: Money.from({ amount: '10.00', currency: 'USD' }),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it('rejects unbalanced ledger entry creation', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-bad',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '10.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '95.00', currency: 'BRL' }),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });
});

describe('WagerTransaction', () => {
  const baseProps = {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
  };

  it('enforces reference requirements and blocks external OPENING submissions', () => {
    expect(() =>
      WagerTransaction.create({ ...baseProps, kind: WagerTransactionKind.Opening }),
    ).toThrow(DomainRuleViolationError);

    expect(() =>
      WagerTransaction.create({ ...baseProps, kind: WagerTransactionKind.Refund }),
    ).toThrow(DomainRuleViolationError);

    expect(() =>
      WagerTransaction.create({ ...baseProps, kind: WagerTransactionKind.Rollback }),
    ).toThrow(DomainRuleViolationError);
  });

  it('computes correct ledger direction for BET, WIN, REFUND and ROLLBACK', () => {
    const bet = WagerTransaction.create({ ...baseProps, kind: WagerTransactionKind.Bet });
    const win = WagerTransaction.create({ ...baseProps, kind: WagerTransactionKind.Win });
    const refund = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-1',
    });
    const rollback = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'ext-1',
    });

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  it('prevents state transitions once terminal status is reached', () => {
    const tx = WagerTransaction.create({ ...baseProps, kind: WagerTransactionKind.Bet });
    expect(tx.status).toBe(WagerTransactionStatus.Pending);

    tx.markProcessed(undefined, new Date(), Money.from({ amount: '75.00', currency: 'BRL' }));
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.isTerminal()).toBe(true);

    expect(() => tx.reject(FailureCode.INSUFFICIENT_FUNDS)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.INFRASTRUCTURE_ERROR)).toThrow(InvalidTransactionStateError);
  });
});