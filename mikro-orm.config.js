"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const migrations_1 = require("@mikro-orm/migrations");
const postgresql_1 = require("@mikro-orm/postgresql");
const inbox_message_orm_entity_1 = require("./src/infrastructure/database/entities/inbox-message.orm-entity");
const outbox_message_orm_entity_1 = require("./src/infrastructure/database/entities/outbox-message.orm-entity");
const wager_transaction_orm_entity_1 = require("./src/infrastructure/database/entities/wager-transaction.orm-entity");
const wallet_ledger_entry_orm_entity_1 = require("./src/infrastructure/database/entities/wallet-ledger-entry.orm-entity");
const wallet_orm_entity_1 = require("./src/infrastructure/database/entities/wallet.orm-entity");
const Migration20261117000001_InitialSchema_1 = require("./src/infrastructure/database/migrations/Migration20261117000001_InitialSchema");
exports.default = (0, postgresql_1.defineConfig)({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5433),
    user: process.env.DB_USER ?? 'wagering',
    password: process.env.DB_PASSWORD ?? 'wagering',
    dbName: process.env.DB_NAME ?? 'wagering_db',
    entities: [
        wallet_orm_entity_1.WalletOrmEntity,
        wager_transaction_orm_entity_1.WagerTransactionOrmEntity,
        wallet_ledger_entry_orm_entity_1.WalletLedgerEntryOrmEntity,
        inbox_message_orm_entity_1.InboxMessageOrmEntity,
        outbox_message_orm_entity_1.OutboxMessageOrmEntity,
    ],
    extensions: [migrations_1.Migrator],
    migrations: {
        tableName: 'mikro_orm_migrations',
        path: 'src/infrastructure/database/migrations',
        migrationsList: [
            {
                name: 'Migration20261117000001_InitialSchema',
                class: Migration20261117000001_InitialSchema_1.Migration20261117000001_InitialSchema,
            },
        ],
    },
});
//# sourceMappingURL=mikro-orm.config.js.map