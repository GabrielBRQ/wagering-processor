import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
    InboxRepository,
    LedgerPage,
    LedgerRepository,
    OutboxRepository,
    TransactionContext,
    UnitOfWork,
    WagerTransactionRepository,
    WalletRepository,
} from '../../../application/ports/repositories.port';
import { InboxMessage } from '../../../domain/entities/inbox-message.entity';
import { OutboxMessage } from '../../../domain/entities/outbox-message.entity';
import {
    WagerTransaction,
    WagerTransactionKind,
    WagerTransactionStatus,
} from '../../../domain/entities/wager-transaction.entity';
import { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry.entity';
import { Wallet } from '../../../domain/entities/wallet.entity';
import { MetricsService } from '../../observability/metrics.service';
import { InboxMessageOrmEntity } from '../entities/inbox-message.orm-entity';
import { OutboxMessageOrmEntity } from '../entities/outbox-message.orm-entity';
import { WagerTransactionOrmEntity } from '../entities/wager-transaction.orm-entity';
import { WalletLedgerEntryOrmEntity } from '../entities/wallet-ledger-entry.orm-entity';
import { WalletOrmEntity } from '../entities/wallet.orm-entity';
import {
    InboxMessageMapper,
    OutboxMessageMapper,
    WagerTransactionMapper,
    WalletLedgerEntryMapper,
    WalletMapper,
} from '../mappers/database.mappers';

interface LedgerCursorPayload {
    createdAt: string;
    id: string;
}

function encodeCursor(payload: LedgerCursorPayload): string {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): LedgerCursorPayload {
    try {
        const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
        const parsed = JSON.parse(decoded) as Partial<LedgerCursorPayload>;
        if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
            throw new Error('Invalid cursor structure');
        }
        const date = new Date(parsed.createdAt);
        if (Number.isNaN(date.getTime())) {
            throw new Error('Invalid cursor timestamp');
        }
        return { createdAt: parsed.createdAt, id: parsed.id };
    } catch {
        throw new Error('INVALID_CURSOR');
    }
}

export class MikroOrmWalletRepository implements WalletRepository {
    constructor(
        private readonly em: EntityManager,
        private readonly metrics?: MetricsService,
    ) { }

    async findById(id: string): Promise<Wallet | null> {
        const orm = await this.em.findOne(WalletOrmEntity, { id });
        return orm ? WalletMapper.toDomain(orm) : null;
    }

    async findByIdForUpdate(id: string): Promise<Wallet | null> {
        const lockStart = performance.now();
        const orm = await this.em.findOne(
            WalletOrmEntity,
            { id },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        const waitMs = performance.now() - lockStart;

        if (waitMs >= 10) {
            this.metrics?.incrementLockConflicts();
        }

        return orm ? WalletMapper.toDomain(orm) : null;
    }

    async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
        const orm = await this.em.findOne(WalletOrmEntity, { playerId, currency });
        return orm ? WalletMapper.toDomain(orm) : null;
    }

    async save(wallet: Wallet): Promise<void> {
        const existing = this.em
            .getUnitOfWork()
            .getById<WalletOrmEntity>(WalletOrmEntity.name, wallet.id);
        if (existing) {
            WalletMapper.toOrm(wallet, existing);
            return;
        }
        const orm = WalletMapper.toOrm(wallet);
        this.em.persist(orm);
    }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
    constructor(private readonly em: EntityManager) { }

    async findById(id: string): Promise<WagerTransaction | null> {
        const orm = await this.em.findOne(WagerTransactionOrmEntity, { id });
        return orm ? WagerTransactionMapper.toDomain(orm) : null;
    }

    async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null> {
        const orm = await this.em.findOne(WagerTransactionOrmEntity, { idempotencyKey });
        return orm ? WagerTransactionMapper.toDomain(orm) : null;
    }

    async findByProviderAndExternalId(
        providerId: string,
        externalTransactionId: string,
    ): Promise<WagerTransaction | null> {
        const orm = await this.em.findOne(WagerTransactionOrmEntity, {
            providerId,
            externalTransactionId,
        });
        return orm ? WagerTransactionMapper.toDomain(orm) : null;
    }

    async hasProcessedReversalFor(referenceTransactionId: string): Promise<boolean> {
        const count = await this.em.count(WagerTransactionOrmEntity, {
            referenceTransaction: referenceTransactionId,
            status: WagerTransactionStatus.Processed,
            kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
        });
        return count > 0;
    }

    async findDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]> {
        const list = await this.em.find(
            WagerTransactionOrmEntity,
            {
                status: WagerTransactionStatus.PendingReference,
                createdAt: { $lte: now },
            },
            {
                orderBy: { createdAt: 'ASC' },
                limit,
                lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
            },
        );
        return list.map(WagerTransactionMapper.toDomain);
    }

    async save(transaction: WagerTransaction): Promise<void> {
        const existing = this.em
            .getUnitOfWork()
            .getById<WagerTransactionOrmEntity>(WagerTransactionOrmEntity.name, transaction.id);
        if (existing) {
            WagerTransactionMapper.toOrm(transaction, this.em, existing);
            return;
        }
        const orm = WagerTransactionMapper.toOrm(transaction, this.em);
        this.em.persist(orm);
    }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
    constructor(private readonly em: EntityManager) { }

    async append(entry: WalletLedgerEntry): Promise<void> {
        const orm = WalletLedgerEntryMapper.toOrm(entry, this.em);
        this.em.persist(orm);
    }

    async findByWalletPaginated(
        walletId: string,
        cursor: string | undefined,
        limit: number,
    ): Promise<LedgerPage> {
        const safeLimit = Math.min(Math.max(limit, 1), 100);
        const parsedCursor = cursor ? decodeCursor(cursor) : undefined;

        const where = parsedCursor
            ? {
                wallet: walletId,
                $or: [
                    { createdAt: { $gt: new Date(parsedCursor.createdAt) } },
                    {
                        createdAt: new Date(parsedCursor.createdAt),
                        id: { $gt: parsedCursor.id },
                    },
                ],
            }
            : { wallet: walletId };

        const rows = await this.em.find(WalletLedgerEntryOrmEntity, where, {
            orderBy: { createdAt: 'ASC', id: 'ASC' },
            limit: safeLimit + 1,
        });

        const hasMore = rows.length > safeLimit;
        const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;
        const entries = pageRows.map(WalletLedgerEntryMapper.toDomain);

        const lastEntry = entries[entries.length - 1];
        const nextCursor =
            hasMore && lastEntry
                ? encodeCursor({
                    createdAt: lastEntry.createdAt.toISOString(),
                    id: lastEntry.id,
                })
                : null;

        return { entries, nextCursor };
    }

    async findAllByWallet(walletId: string): Promise<WalletLedgerEntry[]> {
        const rows = await this.em.find(
            WalletLedgerEntryOrmEntity,
            { wallet: walletId },
            { orderBy: { createdAt: 'ASC', id: 'ASC' } },
        );
        return rows.map(WalletLedgerEntryMapper.toDomain);
    }
}

export class MikroOrmInboxRepository implements InboxRepository {
    constructor(private readonly em: EntityManager) { }

    async findByKey(consumerName: string, messageId: string): Promise<InboxMessage | null> {
        const orm = await this.em.findOne(InboxMessageOrmEntity, { consumerName, messageId });
        return orm ? InboxMessageMapper.toDomain(orm) : null;
    }

    async save(message: InboxMessage): Promise<void> {
        const existing = await this.em.findOne(InboxMessageOrmEntity, {
            consumerName: message.consumerName,
            messageId: message.messageId,
        });
        if (existing) {
            InboxMessageMapper.toOrm(message, existing);
            return;
        }
        const orm = InboxMessageMapper.toOrm(message);
        this.em.persist(orm);
    }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
    constructor(private readonly em: EntityManager) { }

    async enqueue(messages: OutboxMessage[]): Promise<void> {
        for (const msg of messages) {
            const orm = OutboxMessageMapper.toOrm(msg);
            this.em.persist(orm);
        }
    }

    async claimDueBatch(now: Date, limit: number): Promise<OutboxMessage[]> {
        const rows = await this.em.find(
            OutboxMessageOrmEntity,
            {
                publishedAt: null,
                $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
            },
            {
                orderBy: { occurredAt: 'ASC' },
                limit,
                lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
            },
        );
        return rows.map(OutboxMessageMapper.toDomain);
    }

    async save(message: OutboxMessage): Promise<void> {
        const existing = this.em
            .getUnitOfWork()
            .getById<OutboxMessageOrmEntity>(OutboxMessageOrmEntity.name, message.id);
        if (existing) {
            OutboxMessageMapper.toOrm(message, existing);
            return;
        }
        const orm = OutboxMessageMapper.toOrm(message);
        this.em.persist(orm);
    }

    async countPending(): Promise<number> {
        return this.em.count(OutboxMessageOrmEntity, { publishedAt: null });
    }

    async oldestPendingAgeSeconds(now: Date): Promise<number> {
        const oldest = await this.em.findOne(
            OutboxMessageOrmEntity,
            { publishedAt: null },
            { orderBy: { occurredAt: 'ASC' } },
        );
        if (!oldest) {
            return 0;
        }
        return Math.max(0, Number(((now.getTime() - oldest.occurredAt.getTime()) / 1000).toFixed(2)));
    }
}

@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWork {
    constructor(
        private readonly em: EntityManager,
        @Optional() @Inject(MetricsService) private readonly metrics?: MetricsService,
    ) { }

    async runInTransaction<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T> {
        try {
            return await this.em.transactional(async (txEm) => {
                const ctx: TransactionContext = {
                    wallets: new MikroOrmWalletRepository(txEm, this.metrics),
                    transactions: new MikroOrmWagerTransactionRepository(txEm),
                    ledger: new MikroOrmLedgerRepository(txEm),
                    inbox: new MikroOrmInboxRepository(txEm),
                    outbox: new MikroOrmOutboxRepository(txEm),
                };
                return work(ctx);
            });
        } catch (error: unknown) {
            const pgCode =
                (error as { code?: string; cause?: { code?: string } })?.code ??
                (error as { cause?: { code?: string } })?.cause?.code;

            if (pgCode === '55P03' || pgCode === '40P01' || pgCode === '40001') {
                this.metrics?.incrementLockConflicts();
            }
            throw error;
        }
    }
}