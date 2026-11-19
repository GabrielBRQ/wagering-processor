import { describe, expect, it } from 'bun:test';
import { InboxMessage } from '../entities/inbox-message.entity';
import { OutboxMessage } from '../entities/outbox-message.entity';
import { Wallet } from '../entities/wallet.entity';
import { Money } from '../value-objects/money';
import { WalletBalanceChanged } from './integration-event';

describe('IntegrationEvent, InboxMessage & OutboxMessage', () => {
  it('serializes WalletBalanceChanged with MoneyProps strings rather than Money instances', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const entry = wallet.debit({
      entryId: 'entry-1',
      transactionId: 'tx-1',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });

    const occurredAt = new Date('2026-11-17T18:00:00.000Z');
    const event = WalletBalanceChanged.from(wallet, entry, {
      eventId: 'evt-1',
      correlationId: 'corr-1',
      causationId: 'tx-1',
      occurredAt,
    });

    const json = event.toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe('2026-11-17T18:00:00.000Z');
    expect(json.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(json.data.balanceBefore).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(json.data.balanceAfter).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(json.data.walletVersion).toBe(2);
  });

  it('tracks InboxMessage receipt and processing state', () => {
    const receivedAt = new Date('2026-11-17T18:00:00.000Z');
    const inbox = InboxMessage.receive({
      messageId: 'msg-123',
      consumerName: 'sqs-wager-consumer',
      payloadHash: 'sha256-abc',
      receivedAt,
    });

    expect(inbox.isProcessed()).toBe(false);
    expect(inbox.processedAt).toBeUndefined();

    const processedAt = new Date('2026-11-17T18:00:01.000Z');
    inbox.markProcessed(processedAt);

    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toEqual(processedAt);
  });

  it('enqueues OutboxMessage, schedules exponential backoff retries, and marks published', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
    });
    const entry = wallet.credit({
      entryId: 'entry-1',
      transactionId: 'tx-1',
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
    });

    const t0 = new Date('2026-11-17T18:00:00.000Z');
    const event = WalletBalanceChanged.from(wallet, entry, {
      eventId: 'evt-1',
      correlationId: 'corr-1',
      occurredAt: t0,
    });

    const outbox = OutboxMessage.enqueue(event);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(t0)).toBe(true);
    expect(outbox.attempts).toBe(0);

    // Primeira falha -> próximo envio em +1s
    outbox.scheduleRetry(t0);
    expect(outbox.attempts).toBe(1);
    expect(outbox.isDue(t0)).toBe(false);
    expect(outbox.isDue(new Date('2026-11-17T18:00:01.000Z'))).toBe(true);

    // Publicação concluída
    outbox.markPublished(new Date('2026-11-17T18:00:01.500Z'));
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(new Date('2026-11-17T18:05:00.000Z'))).toBe(false);
  });
});