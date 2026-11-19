import { createHash } from 'node:crypto';
import { WagerTransactionKind } from '../../domain/entities/wager-transaction.entity';
import { MoneyProps } from '../../domain/value-objects/money';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        sorted[key] = canonicalize(entry);
      }
    }
    return sorted;
  }
  return value;
}

export function computeCanonicalHash(input: unknown): string {
  const canonicalJson = JSON.stringify(canonicalize(input));
  return createHash('sha256').update(canonicalJson).digest('hex');
}

export interface WagerBusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/**
 * Gera o hash canônico apenas dos campos de negócio da transação,
 * ignorando headers HTTP e metadados de transporte SQS.
 */
export function computeWagerPayloadHash(payload: WagerBusinessPayload): string {
  const normalized: Record<string, unknown> = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: {
      amount: payload.money.amount,
      currency: payload.money.currency,
    },
  };

  if (payload.referenceExternalTransactionId?.trim()) {
    normalized.referenceExternalTransactionId = payload.referenceExternalTransactionId.trim();
  }

  return computeCanonicalHash(normalized);
}