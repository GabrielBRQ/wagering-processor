import { Migration } from '@mikro-orm/migrations';

export class Migration20261117000001_InitialSchema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE "wallets" (
        "id" uuid NOT NULL,
        "player_id" varchar(128) NOT NULL,
        "currency" varchar(3) NOT NULL,
        "balance" numeric(20, 2) NOT NULL,
        "version" integer NOT NULL DEFAULT 1,
        "created_at" timestamptz NOT NULL,
        "updated_at" timestamptz NOT NULL,
        CONSTRAINT "pk_wallets" PRIMARY KEY ("id"),
        CONSTRAINT "uq_wallets_player_currency" UNIQUE ("player_id", "currency"),
        CONSTRAINT "chk_wallets_balance_non_negative" CHECK ("balance" >= 0),
        CONSTRAINT "chk_wallets_version_positive" CHECK ("version" >= 1),
        CONSTRAINT "chk_wallets_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql(`
      CREATE TABLE "wager_transactions" (
        "id" uuid NOT NULL,
        "provider_id" varchar(128) NOT NULL,
        "external_transaction_id" varchar(255) NOT NULL,
        "idempotency_key" varchar(384) NOT NULL,
        "payload_hash" varchar(64) NOT NULL,
        "wallet_id" uuid NOT NULL,
        "player_id" varchar(128) NOT NULL,
        "round_id" varchar(255) NOT NULL,
        "game_id" varchar(255) NOT NULL,
        "kind" varchar(32) NOT NULL,
        "status" varchar(32) NOT NULL,
        "amount" numeric(20, 2) NOT NULL,
        "currency" varchar(3) NOT NULL,
        "reference_external_transaction_id" varchar(255) NULL,
        "reference_transaction_id" uuid NULL,
        "failure_code" varchar(64) NULL,
        "balance_after" numeric(20, 2) NULL,
        "created_at" timestamptz NOT NULL,
        "processed_at" timestamptz NULL,
        CONSTRAINT "pk_wager_transactions" PRIMARY KEY ("id"),
        CONSTRAINT "fk_wager_tx_wallet" FOREIGN KEY ("wallet_id") REFERENCES "wallets" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_wager_tx_reference" FOREIGN KEY ("reference_transaction_id") REFERENCES "wager_transactions" ("id") ON DELETE RESTRICT,
        CONSTRAINT "uq_wager_tx_provider_external" UNIQUE ("provider_id", "external_transaction_id"),
        CONSTRAINT "uq_wager_tx_idempotency_key" UNIQUE ("idempotency_key"),
        CONSTRAINT "chk_wager_tx_amount_non_negative" CHECK ("amount" >= 0),
        CONSTRAINT "chk_wager_tx_kind" CHECK ("kind" IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT "chk_wager_tx_status" CHECK ("status" IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'))
      );
    `);

    this.addSql(`
      CREATE INDEX "idx_wager_tx_wallet_created"
        ON "wager_transactions" ("wallet_id", "created_at" DESC);
    `);
    this.addSql(`
      CREATE INDEX "idx_wager_tx_round"
        ON "wager_transactions" ("round_id");
    `);
    this.addSql(`
      CREATE INDEX "idx_wager_tx_status_ref"
        ON "wager_transactions" ("status", "provider_id", "reference_external_transaction_id");
    `);
    this.addSql(`
      CREATE UNIQUE INDEX "uq_wager_tx_single_active_reversal"
        ON "wager_transactions" ("reference_transaction_id")
        WHERE "status" = 'PROCESSED' AND "kind" IN ('REFUND', 'ROLLBACK');
    `);

    this.addSql(`
      CREATE TABLE "wallet_ledger_entries" (
        "id" uuid NOT NULL,
        "wallet_id" uuid NOT NULL,
        "transaction_id" uuid NOT NULL,
        "direction" varchar(16) NOT NULL,
        "amount" numeric(20, 2) NOT NULL,
        "currency" varchar(3) NOT NULL,
        "balance_before" numeric(20, 2) NOT NULL,
        "balance_after" numeric(20, 2) NOT NULL,
        "created_at" timestamptz NOT NULL,
        CONSTRAINT "pk_wallet_ledger_entries" PRIMARY KEY ("id"),
        CONSTRAINT "fk_ledger_wallet" FOREIGN KEY ("wallet_id") REFERENCES "wallets" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_ledger_transaction" FOREIGN KEY ("transaction_id") REFERENCES "wager_transactions" ("id") ON DELETE RESTRICT,
        CONSTRAINT "uq_ledger_transaction_id" UNIQUE ("transaction_id"),
        CONSTRAINT "chk_ledger_direction" CHECK ("direction" IN ('DEBIT', 'CREDIT')),
        CONSTRAINT "chk_ledger_amount_positive" CHECK ("amount" > 0),
        CONSTRAINT "chk_ledger_balances_non_negative" CHECK ("balance_before" >= 0 AND "balance_after" >= 0),
        CONSTRAINT "chk_ledger_arithmetic_invariant" CHECK (
          ("direction" = 'CREDIT' AND "balance_before" + "amount" = "balance_after")
          OR
          ("direction" = 'DEBIT' AND "balance_before" - "amount" = "balance_after")
        )
      );
    `);

    this.addSql(`
      CREATE INDEX "idx_ledger_wallet_created"
        ON "wallet_ledger_entries" ("wallet_id", "created_at" ASC, "id" ASC);
    `);

    this.addSql(`
      CREATE TABLE "inbox_messages" (
        "consumer_name" varchar(128) NOT NULL,
        "message_id" varchar(255) NOT NULL,
        "payload_hash" varchar(64) NOT NULL,
        "received_at" timestamptz NOT NULL,
        "processed_at" timestamptz NULL,
        CONSTRAINT "pk_inbox_messages" PRIMARY KEY ("consumer_name", "message_id")
      );
    `);

    this.addSql(`
      CREATE TABLE "outbox_messages" (
        "id" uuid NOT NULL,
        "aggregate_id" uuid NOT NULL,
        "event_type" varchar(128) NOT NULL,
        "payload" jsonb NOT NULL,
        "occurred_at" timestamptz NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "next_attempt_at" timestamptz NULL,
        "published_at" timestamptz NULL,
        CONSTRAINT "pk_outbox_messages" PRIMARY KEY ("id")
      );
    `);

    this.addSql(`
      CREATE INDEX "idx_outbox_pending_due"
        ON "outbox_messages" ("next_attempt_at" ASC, "occurred_at" ASC)
        WHERE "published_at" IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "outbox_messages";`);
    this.addSql(`DROP TABLE IF EXISTS "inbox_messages";`);
    this.addSql(`DROP TABLE IF EXISTS "wallet_ledger_entries";`);
    this.addSql(`DROP TABLE IF EXISTS "wager_transactions";`);
    this.addSql(`DROP TABLE IF EXISTS "wallets";`);
  }
}