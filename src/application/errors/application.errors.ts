export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundApplicationError extends ApplicationError {
  readonly code = 'NOT_FOUND';

  constructor(resource: string, identifier: string) {
    super(`${resource} "${identifier}" was not found`);
  }
}

export class WalletConflictError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`Wallet already exists for player "${playerId}" and currency "${currency}"`);
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(idempotencyKey: string) {
    super(`Idempotency key "${idempotencyKey}" was already used with a different payload`);
  }
}

export class ValidationApplicationError extends ApplicationError {
  readonly code = 'VALIDATION_ERROR';

  constructor(message: string) {
    super(message);
  }
}