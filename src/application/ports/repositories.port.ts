import { InboxMessage } from '../../domain/entities/inbox-message.entity';
import { OutboxMessage } from '../../domain/entities/outbox-message.entity';
import { WagerTransaction } from '../../domain/entities/wager-transaction.entity';
import { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry.entity';
import { Wallet } from '../../domain/entities/wallet.entity';

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor: string | null;
}

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  save(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  hasProcessedReversalFor(referenceTransactionId: string): Promise<boolean>;
  findDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]>;
  save(transaction: WagerTransaction): Promise<void>;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  findByWalletPaginated(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage>;
  findAllByWallet(walletId: string): Promise<WalletLedgerEntry[]>;
}

export interface InboxRepository {
  findByKey(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  save(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
  claimDueBatch(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
  countPending(): Promise<number>;
  oldestPendingAgeSeconds(now: Date): Promise<number>;
}

export interface TransactionContext {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  runInTransaction<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T>;
}