import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../errors/domain.errors';

const MoneyDecimal = Decimal.clone({
  precision: 28,
  rounding: Decimal.ROUND_HALF_UP,
});

type MoneyDecimalInstance = InstanceType<typeof MoneyDecimal>;

const POSITIVE_DECIMAL_PATTERN = /^\d+(\.\d{1,2})?$/;
const SIGNED_DECIMAL_PATTERN = /^-?\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface MoneyProps {
  amount: string;   // decimal string, ex.: "25.00"
  currency: string; // ISO-4217, ex.: "BRL"
}

export class Money {
  private constructor(
    private readonly value: MoneyDecimalInstance,
    public readonly currency: string,
  ) {}

  /**
   * Factory para contratos de entrada (API, fila, criação).
   * Rejeita valores negativos, mais de 2 casas decimais, notação científica, NaN, Infinity e tipos não-string.
   */
  static from(props: MoneyProps): Money {
    if (!props || typeof props.amount !== 'string' || typeof props.currency !== 'string') {
      throw new InvalidMoneyError('Money amount and currency must be strings');
    }

    const currency = Money.validateCurrency(props.currency);

    if (!POSITIVE_DECIMAL_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(
        `Invalid money amount "${props.amount}". Expected non-negative decimal string with up to 2 decimal places`,
      );
    }

    const parsed = new MoneyDecimal(props.amount);
    if (!parsed.isFinite() || parsed.isNaN() || parsed.isNegative()) {
      throw new InvalidMoneyError(`Invalid money amount "${props.amount}"`);
    }

    return new Money(parsed.toDecimalPlaces(2), currency);
  }

  static zero(currency: string): Money {
    const validCurrency = Money.validateCurrency(currency);
    return new Money(new MoneyDecimal(0), validCurrency);
  }

  /**
   * Reconstrói Money a partir da persistência (pode conter saldo zero, positivo ou diferença negativa na reconciliação).
   */
  static rehydrate(props: MoneyProps): Money {
    const currency = Money.validateCurrency(props.currency);

    if (typeof props.amount !== 'string' || !SIGNED_DECIMAL_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(`Cannot rehydrate invalid money amount "${props.amount}"`);
    }

    const parsed = new MoneyDecimal(props.amount);
    if (!parsed.isFinite() || parsed.isNaN()) {
      throw new InvalidMoneyError(`Cannot rehydrate non-finite money amount "${props.amount}"`);
    }

    return new Money(parsed.toDecimalPlaces(2), currency);
  }

  private static validateCurrency(currency: string): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(
        `Invalid currency "${currency}". Expected 3-letter uppercase ISO-4217 code (e.g. BRL)`,
      );
    }
    return currency;
  }

  get amount(): string {
    return this.value.toFixed(2);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value).toDecimalPlaces(2), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value).toDecimalPlaces(2), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated().toDecimalPlaces(2), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}