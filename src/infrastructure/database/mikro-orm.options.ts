import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { InboxMessageOrmEntity } from './entities/inbox-message.orm-entity';
import { OutboxMessageOrmEntity } from './entities/outbox-message.orm-entity';
import { WagerTransactionOrmEntity } from './entities/wager-transaction.orm-entity';
import { WalletLedgerEntryOrmEntity } from './entities/wallet-ledger-entry.orm-entity';
import { WalletOrmEntity } from './entities/wallet.orm-entity';
import { Migration20261117000001_InitialSchema } from './migrations/Migration20261117000001_InitialSchema';

export const mikroOrmOptions = defineConfig({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5433),
  user: process.env.DB_USER ?? 'wagering',
  password: process.env.DB_PASSWORD ?? 'wagering',
  dbName: process.env.DB_NAME ?? 'wagering_db',
  entities: [
    WalletOrmEntity,
    WagerTransactionOrmEntity,
    WalletLedgerEntryOrmEntity,
    InboxMessageOrmEntity,
    OutboxMessageOrmEntity,
  ],
  extensions: [Migrator],
  migrations: {
    tableName: 'mikro_orm_migrations',
    path: 'src/infrastructure/database/migrations',
    migrationsList: [
      {
        name: 'Migration20261117000001_InitialSchema',
        class: Migration20261117000001_InitialSchema,
      },
    ],
  },
});

export default mikroOrmOptions;