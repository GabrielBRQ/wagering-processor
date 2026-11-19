import { Injectable } from '@nestjs/common';

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: unknown;
}

@Injectable()
export class StructuredLogger {
  info(event: string, context: LogContext = {}): void {
    this.write('INFO', event, context);
  }

  warn(event: string, context: LogContext = {}): void {
    this.write('WARN', event, context);
  }

  error(event: string, context: LogContext = {}, error?: unknown): void {
    const errorInfo =
      error instanceof Error
        ? { errorName: error.name, errorMessage: error.message }
        : error !== undefined
          ? { errorMessage: String(error) }
          : {};

    this.write('ERROR', event, { ...context, ...errorInfo });
  }

  private write(level: 'INFO' | 'WARN' | 'ERROR', event: string, context: LogContext): void {
    const record = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...context,
    };

    const line = JSON.stringify(record);
    if (level === 'ERROR') {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }
}