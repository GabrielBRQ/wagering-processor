import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Injectable } from '@nestjs/common';

@Injectable()
export class SqsGateway {
  readonly client: SQSClient;
  readonly queueUrl: string;
  readonly dlqUrl: string;

  constructor() {
    const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
    const region = process.env.AWS_REGION ?? 'us-east-1';

    this.queueUrl =
      process.env.SQS_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-transactions.fifo';
    this.dlqUrl =
      process.env.SQS_DLQ_URL ?? 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';

    this.client = new SQSClient({
      region,
      endpoint,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.queueUrl,
          AttributeNames: ['QueueArn'],
        }),
      );
      return true;
    } catch {
      return false;
    }
  }
}