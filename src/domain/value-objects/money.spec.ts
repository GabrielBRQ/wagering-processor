import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../errors/domain.errors';
import { Money } from './money';

describe('Money Value Object', () => {
  it('creates valid money and formats with fixed 2 decimal places', () => {
    const a = Money.from({ amount: '25', currency: 'BRL' });
    const b = Money.from({ amount: '10.5', currency: 'BRL' });
    const c = Money.from({ amount: '0.00', currency: 'BRL' });

    expect(a.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(b.toJSON()).toEqual({ amount: '10.50', currency: 'BRL' });
    expect(c.isZero()).toBe(true);
  });

  it('performs exact decimal arithmetic without floating-point drift and preserves immutability', () => {
    const a = Money.from({ amount: '0.10', currency: 'BRL' });
    const b = Money.from({ amount: '0.20', currency: 'BRL' });

    const sum = a.add(b);
    expect(sum.toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
    // Imutabilidade: instâncias originais permanecem intactas
    expect(a.toJSON()).toEqual({ amount: '0.10', currency: 'BRL' });
    expect(b.toJSON()).toEqual({ amount: '0.20', currency: 'BRL' });

    const diff = a.subtract(b);
    expect(diff.isNegative()).toBe(true);
    expect(diff.toJSON()).toEqual({ amount: '-0.10', currency: 'BRL' });
  });

  it('rejects invalid input strings, negative amounts, scientific notation and >2 decimals', () => {
    const invalidAmounts = ['', '   ', 'NaN', 'Infinity', '-Infinity', '1e2', '10.123', '-5.00', '10.', '.50'];

    for (const amount of invalidAmounts) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    }

    // Rejeita number passado em runtime via cast inseguro
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it('rejects invalid currency codes and throws CurrencyMismatchError across different currencies', () => {
    expect(() => Money.from({ amount: '10.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '10.00', currency: '' })).toThrow(InvalidMoneyError);

    const brl = Money.from({ amount: '50.00', currency: 'BRL' });
    const usd = Money.from({ amount: '50.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl.equals(usd)).toBe(false);
  });
});