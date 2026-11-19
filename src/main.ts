import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn'],
  });

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), level: 'INFO', event: 'server.started', port })}\n`,
  );
}

void bootstrap();