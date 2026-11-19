export enum FailureCode {
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  REVERSAL_INSUFFICIENT_FUNDS = 'REVERSAL_INSUFFICIENT_FUNDS',
  REFERENCE_NOT_FOUND = 'REFERENCE_NOT_FOUND',
  INVALID_REFERENCE_KIND = 'INVALID_REFERENCE_KIND',
  INVALID_REFERENCE_STATUS = 'INVALID_REFERENCE_STATUS',
  REFERENCE_MISMATCH = 'REFERENCE_MISMATCH',
  AMOUNT_MISMATCH = 'AMOUNT_MISMATCH',
  ALREADY_REVERSED = 'ALREADY_REVERSED',
  WALLET_NOT_FOUND = 'WALLET_NOT_FOUND',
  WALLET_CURRENCY_MISMATCH = 'WALLET_CURRENCY_MISMATCH',
  PLAYER_WALLET_MISMATCH = 'PLAYER_WALLET_MISMATCH',
  INVALID_OPERATION_KIND = 'INVALID_OPERATION_KIND',
  INFRASTRUCTURE_ERROR = 'INFRASTRUCTURE_ERROR',
}

export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientBalanceError extends DomainError {
  readonly code = FailureCode.INSUFFICIENT_FUNDS;

  constructor(walletId: string, balance: string, attempted: string) {
    super(`Insufficient balance on wallet ${walletId}: available ${balance}, required ${attempted}`);
  }
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(transactionId: string, currentStatus: string, targetAction: string) {
    super(
      `Cannot perform "${targetAction}" on transaction ${transactionId} in status ${currentStatus}`,
    );
  }
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';

  constructor(message: string) {
    super(message);
  }
}

export class DomainRuleViolationError extends DomainError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}