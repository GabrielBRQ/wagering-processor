import { EntityManager } from '@mikro-orm/postgresql';
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SqsGateway } from '../../infrastructure/messaging/sqs-client.provider';
import { MetricsService } from '../../infrastructure/observability/metrics.service';

@Controller()
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsGateway,
    private readonly metrics: MetricsService,
  ) {}

  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const postgresOk = await this.checkPostgres();
    const sqsOk = await this.sqs.isHealthy();
    const allReady = postgresOk && sqsOk;

    if (!allReady) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return {
      status: allReady ? 'ready' : 'degraded',
      dependencies: {
        postgres: postgresOk ? 'up' : 'down',
        sqs: sqsOk ? 'up' : 'down',
      },
    };
  }

  @Get('metrics')
  getMetrics() {
    return this.metrics.snapshot();
  }

  private async checkPostgres(): Promise<boolean> {
    try {
      await this.em.getConnection().execute('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}