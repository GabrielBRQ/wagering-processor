import { EntityManager } from '@mikro-orm/postgresql';
import { InboxMessage } from '../../../domain/entities/inbox-message.entity';
import { OutboxMessage } from '../../../domain/entities/outbox-message.entity';
import { WagerTransaction } from '../../../domain/entities/wager-transaction.entity';
import { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry.entity';
import { Wallet } from '../../../domain/entities/wallet.entity';
import { Money } from '../../../domain/value-objects/money';
import { InboxMessageOrmEntity } from '../entities/inbox-message.orm-entity';
import { OutboxMessageOrmEntity } from '../entities/outbox-message.orm-entity';
import { WagerTransactionOrmEntity } from '../entities/wager-transaction.orm-entity';
import { WalletLedgerEntryOrmEntity } from '../entities/wallet-ledger-entry.orm-entity';
import { WalletOrmEntity } from '../entities/wallet.orm-entity';

export class WalletMapper {
  static toDomain(orm: WalletOrmEntity): Wallet {
    return Wallet.rehydrate({
      id: orm.id,
      playerId: orm.playerId,
      currency: orm.currency,
      balance: Money.rehydrate({ amount: orm.balance, currency: orm.currency }),
      version: orm.version,
      createdAt: orm.createdAt,
      updatedAt: orm.updatedAt,
    });
  }

  static toOrm(domain: Wallet, target?: WalletOrmEntity): WalletOrmEntity {
    const orm = target ?? new WalletOrmEntity();
    orm.id = domain.id;
    orm.playerId = domain.playerId;
    orm.currency = domain.currency;
    orm.balance = domain.balance.amount;
    orm.version = domain.version;
    orm.createdAt = domain.createdAt;
    orm.updatedAt = domain.updatedAt;
    return orm;
  }
}

export class WagerTransactionMapper {
  static toDomain(orm: WagerTransactionOrmEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: orm.id,
      providerId: orm.providerId,
      externalTransactionId: orm.externalTransactionId,
      idempotencyKey: orm.idempotencyKey,
      payloadHash: orm.payloadHash,
      walletId: orm.wallet.id,
      playerId: orm.playerId,
      roundId: orm.roundId,
      gameId: orm.gameId,
      kind: orm.kind,
      money: Money.rehydrate({ amount: orm.amount, currency: orm.currency }),
      referenceExternalTransactionId: orm.referenceExternalTransactionId ?? undefined,
      createdAt: orm.createdAt,
      status: orm.status,
      referenceTransactionId: orm.referenceTransaction?.id ?? undefined,
      failureCode: orm.failureCode ?? undefined,
      processedAt: orm.processedAt ?? undefined,
      balanceAfter: orm.balanceAfter
        ? Money.rehydrate({ amount: orm.balanceAfter, currency: orm.currency })
        : undefined,
    });
  }

  static toOrm(
    domain: WagerTransaction,
    em: EntityManager,
    target?: WagerTransactionOrmEntity,
  ): WagerTransactionOrmEntity {
    const orm = target ?? new WagerTransactionOrmEntity();
    orm.id = domain.id;
    orm.providerId = domain.providerId;
    orm.externalTransactionId = domain.externalTransactionId;
    orm.idempotencyKey = domain.idempotencyKey;
    orm.payloadHash = domain.payloadHash;
    orm.wallet = em.getReference(WalletOrmEntity, domain.walletId);
    orm.playerId = domain.playerId;
    orm.roundId = domain.roundId;
    orm.gameId = domain.gameId;
    orm.kind = domain.kind;
    orm.status = domain.status;
    orm.amount = domain.money.amount;
    orm.currency = domain.money.currency;
    orm.referenceExternalTransactionId = domain.referenceExternalTransactionId ?? null;
    orm.referenceTransaction = domain.referenceTransactionId
      ? em.getReference(WagerTransactionOrmEntity, domain.referenceTransactionId)
      : null;
    orm.failureCode = domain.failureCode ?? null;
    orm.balanceAfter = domain.balanceAfter ? domain.balanceAfter.amount : null;
    orm.createdAt = domain.createdAt;
    orm.processedAt = domain.processedAt ?? null;
    return orm;
  }
}

export class WalletLedgerEntryMapper {
  static toDomain(orm: WalletLedgerEntryOrmEntity): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: orm.id,
      walletId: orm.wallet.id,
      transactionId: orm.transaction.id,
      direction: orm.direction,
      money: Money.rehydrate({ amount: orm.amount, currency: orm.currency }),
      balanceBefore: Money.rehydrate({ amount: orm.balanceBefore, currency: orm.currency }),
      balanceAfter: Money.rehydrate({ amount: orm.balanceAfter, currency: orm.currency }),
      createdAt: orm.createdAt,
    });
  }

  static toOrm(domain: WalletLedgerEntry, em: EntityManager): WalletLedgerEntryOrmEntity {
    const orm = new WalletLedgerEntryOrmEntity();
    orm.id = domain.id;
    orm.wallet = em.getReference(WalletOrmEntity, domain.walletId);
    orm.transaction = em.getReference(WagerTransactionOrmEntity, domain.transactionId);
    orm.direction = domain.direction;
    orm.amount = domain.money.amount;
    orm.currency = domain.money.currency;
    orm.balanceBefore = domain.balanceBefore.amount;
    orm.balanceAfter = domain.balanceAfter.amount;
    orm.createdAt = domain.createdAt;
    return orm;
  }
}

export class InboxMessageMapper {
  static toDomain(orm: InboxMessageOrmEntity): InboxMessage {
    return InboxMessage.rehydrate({
      messageId: orm.messageId,
      consumerName: orm.consumerName,
      payloadHash: orm.payloadHash,
      receivedAt: orm.receivedAt,
      processedAt: orm.processedAt ?? undefined,
    });
  }

  static toOrm(domain: InboxMessage, target?: InboxMessageOrmEntity): InboxMessageOrmEntity {
    const orm = target ?? new InboxMessageOrmEntity();
    orm.consumerName = domain.consumerName;
    orm.messageId = domain.messageId;
    orm.payloadHash = domain.payloadHash;
    orm.receivedAt = domain.receivedAt;
    orm.processedAt = domain.processedAt ?? null;
    return orm;
  }
}

export class OutboxMessageMapper {
  static toDomain(orm: OutboxMessageOrmEntity): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: orm.id,
      aggregateId: orm.aggregateId,
      eventType: orm.eventType,
      payload: orm.payload,
      occurredAt: orm.occurredAt,
      attempts: orm.attempts,
      nextAttemptAt: orm.nextAttemptAt ?? undefined,
      publishedAt: orm.publishedAt ?? undefined,
    });
  }

  static toOrm(domain: OutboxMessage, target?: OutboxMessageOrmEntity): OutboxMessageOrmEntity {
    const orm = target ?? new OutboxMessageOrmEntity();
    orm.id = domain.id;
    orm.aggregateId = domain.aggregateId;
    orm.eventType = domain.eventType;
    orm.payload = { ...domain.payload };
    orm.occurredAt = domain.occurredAt;
    orm.attempts = domain.attempts;
    orm.nextAttemptAt = domain.nextAttemptAt ?? null;
    orm.publishedAt = domain.publishedAt ?? null;
    return orm;
  }
}