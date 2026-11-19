import { Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/entities/wager-transaction.entity';
import { FailureCode } from '../../../domain/errors/domain.errors';
import { WalletOrmEntity } from './wallet.orm-entity';

@Entity({ tableName: 'wager_transactions' })
@Unique({
  name: 'uq_wager_tx_provider_external',
  properties: ['providerId', 'externalTransactionId'],
})
@Unique({ name: 'uq_wager_tx_idempotency_key', properties: ['idempotencyKey'] })
@Index({ name: 'idx_wager_tx_wallet_created', properties: ['wallet', 'createdAt'] })
@Index({ name: 'idx_wager_tx_round', properties: ['roundId'] })
@Index({
  name: 'idx_wager_tx_status_ref',
  properties: ['status', 'providerId', 'referenceExternalTransactionId'],
})
export class WagerTransactionOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'provider_id', type: 'varchar', length: 128 })
  providerId!: string;

  @Property({ fieldName: 'external_transaction_id', type: 'varchar', length: 255 })
  externalTransactionId!: string;

  @Property({ fieldName: 'idempotency_key', type: 'varchar', length: 384 })
  idempotencyKey!: string;

  @Property({ fieldName: 'payload_hash', type: 'varchar', length: 64 })
  payloadHash!: string;

  @ManyToOne(() => WalletOrmEntity, { fieldName: 'wallet_id' })
  wallet!: WalletOrmEntity;

  @Property({ fieldName: 'player_id', type: 'varchar', length: 128 })
  playerId!: string;

  @Property({ fieldName: 'round_id', type: 'varchar', length: 255 })
  roundId!: string;

  @Property({ fieldName: 'game_id', type: 'varchar', length: 255 })
  gameId!: string;

  @Property({ type: 'varchar', length: 32 })
  kind!: WagerTransactionKind;

  @Property({ type: 'varchar', length: 32 })
  status!: WagerTransactionStatus;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  amount!: string;

  @Property({ type: 'varchar', length: 3 })
  currency!: string;

  @Property({
    fieldName: 'reference_external_transaction_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  referenceExternalTransactionId?: string | null;

  @ManyToOne(() => WagerTransactionOrmEntity, {
    fieldName: 'reference_transaction_id',
    nullable: true,
  })
  referenceTransaction?: WagerTransactionOrmEntity | null;

  @Property({ fieldName: 'failure_code', type: 'varchar', length: 64, nullable: true })
  failureCode?: FailureCode | null;

  @Property({ fieldName: 'balance_after', type: 'decimal', precision: 20, scale: 2, nullable: true })
  balanceAfter?: string | null;

  @Property({ fieldName: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Property({ fieldName: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt?: Date | null;
}