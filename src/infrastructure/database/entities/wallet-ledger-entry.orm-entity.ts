import { Entity, Index, ManyToOne, OneToOne, PrimaryKey, Property } from '@mikro-orm/core';
import { LedgerDirection } from '../../../domain/entities/wallet-ledger-entry.entity';
import { WagerTransactionOrmEntity } from './wager-transaction.orm-entity';
import { WalletOrmEntity } from './wallet.orm-entity';

@Entity({ tableName: 'wallet_ledger_entries' })
@Index({ name: 'idx_ledger_wallet_created', properties: ['wallet', 'createdAt', 'id'] })
export class WalletLedgerEntryOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne(() => WalletOrmEntity, { fieldName: 'wallet_id' })
  wallet!: WalletOrmEntity;

  @OneToOne(() => WagerTransactionOrmEntity, {
    fieldName: 'transaction_id',
    owner: true,
    unique: 'uq_ledger_transaction_id',
  })
  transaction!: WagerTransactionOrmEntity;

  @Property({ type: 'varchar', length: 16 })
  direction!: LedgerDirection;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  amount!: string;

  @Property({ type: 'varchar', length: 3 })
  currency!: string;

  @Property({ fieldName: 'balance_before', type: 'decimal', precision: 20, scale: 2 })
  balanceBefore!: string;

  @Property({ fieldName: 'balance_after', type: 'decimal', precision: 20, scale: 2 })
  balanceAfter!: string;

  @Property({ fieldName: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}