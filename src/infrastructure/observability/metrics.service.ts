import { Injectable } from '@nestjs/common';

export interface MetricsSnapshot {
  transactionsByStatus: Record<string, number>;
  duplicatesDetected: number;
  retriesTotal: number;
  dlqMessagesTotal: number;
  lockConflictsTotal: number;
  reconciliationDiscrepanciesTotal: number;
  outboxLagSeconds: number;
  processingLatencyMs: {
    count: number;
    avgMs: number;
    maxMs: number;
  };
}

@Injectable()
export class MetricsService {
  private readonly transactionsByStatus = new Map<string, number>();
  private duplicatesDetected = 0;
  private retriesTotal = 0;
  private dlqMessagesTotal = 0;
  private lockConflictsTotal = 0;
  private reconciliationDiscrepanciesTotal = 0;
  private outboxLagSeconds = 0;
  private latencyCount = 0;
  private latencySumMs = 0;
  private latencyMaxMs = 0;

  incrementTransactionStatus(status: string): void {
    this.transactionsByStatus.set(status, (this.transactionsByStatus.get(status) ?? 0) + 1);
  }

  incrementDuplicates(): void {
    this.duplicatesDetected += 1;
  }

  incrementRetries(): void {
    this.retriesTotal += 1;
  }

  incrementDlq(): void {
    this.dlqMessagesTotal += 1;
  }

  incrementLockConflicts(): void {
    this.lockConflictsTotal += 1;
  }

  incrementReconciliationDiscrepancies(): void {
    this.reconciliationDiscrepanciesTotal += 1;
  }

  setOutboxLagSeconds(lagSeconds: number): void {
    this.outboxLagSeconds = lagSeconds;
  }

  recordProcessingLatency(durationMs: number): void {
    this.latencyCount += 1;
    this.latencySumMs += durationMs;
    if (durationMs > this.latencyMaxMs) {
      this.latencyMaxMs = durationMs;
    }
  }

  snapshot(): MetricsSnapshot {
    return {
      transactionsByStatus: Object.fromEntries(this.transactionsByStatus.entries()),
      duplicatesDetected: this.duplicatesDetected,
      retriesTotal: this.retriesTotal,
      dlqMessagesTotal: this.dlqMessagesTotal,
      lockConflictsTotal: this.lockConflictsTotal,
      reconciliationDiscrepanciesTotal: this.reconciliationDiscrepanciesTotal,
      outboxLagSeconds: this.outboxLagSeconds,
      processingLatencyMs: {
        count: this.latencyCount,
        avgMs: this.latencyCount > 0 ? Number((this.latencySumMs / this.latencyCount).toFixed(2)) : 0,
        maxMs: Number(this.latencyMaxMs.toFixed(2)),
      },
    };
  }
}