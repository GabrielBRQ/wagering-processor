import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { mikroOrmOptions } from './mikro-orm.options';

async function migrate(): Promise<void> {
  const orm = await MikroORM.init(mikroOrmOptions);
  try {
    const applied = await orm.migrator.up();
    process.stdout.write(`Migrations applied: ${applied.length}\n`);
  } finally {
    await orm.close(true);
  }
}

migrate().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});