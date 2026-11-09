import { describe, expect, it } from 'vitest';
import { type ShapeRule, displayedViolations, valueViolations } from '../../../harness/shape.ts';

describe('displayedViolations', () => {
  const amount: ShapeRule = { type: 'number', required: true, min: 0, max: 100, decimals: 2 };

  it('accepts numbers in range with few enough decimals', () => {
    expect(displayedViolations('42.5', amount)).toEqual([]);
    expect(displayedViolations('0', amount)).toEqual([]);
  });

  it('rejects non-numbers, out-of-range values and extra decimals', () => {
    expect(displayedViolations('', amount)).toHaveLength(1);
    expect(displayedViolations('forty', amount)).toHaveLength(1);
    expect(displayedViolations('\n42\n', amount)).toEqual(['"\n42\n" should be a number']);
    expect(displayedViolations(' 42', amount)).toHaveLength(1);
    expect(displayedViolations('100.01', amount)).toEqual(['text is above 100']);
    expect(displayedViolations('1.234', amount)).toEqual(['text has more than 2 decimals']);
  });

  it('checks string length, allowed values and patterns', () => {
    expect(
      displayedViolations('EUR', { type: 'string', required: true, allowed: ['EUR', 'USD'] }),
    ).toEqual([]);
    expect(
      displayedViolations('YEN', { type: 'string', required: true, allowed: ['EUR', 'USD'] }),
    ).toHaveLength(1);
    expect(displayedViolations('', { type: 'string', required: true, minLength: 1 })).toHaveLength(
      1,
    );
    expect(
      displayedViolations('ORD-AB12', {
        type: 'string',
        required: true,
        pattern: '^ORD-[A-Z0-9]{4}$',
      }),
    ).toEqual([]);
    expect(
      displayedViolations('ORD-ab12', {
        type: 'string',
        required: true,
        pattern: '^ORD-[A-Z0-9]{4}$',
      }),
    ).toHaveLength(1);
  });

  it('lets an optional value be absent', () => {
    expect(displayedViolations('', { type: 'string', required: false, minLength: 3 })).toEqual([]);
  });

  it('parses objects as JSON and checks every field, ignoring key order', () => {
    const rule: ShapeRule = {
      type: 'object',
      required: true,
      fields: {
        id: { type: 'exact', required: true, value: 'r1' },
        label: { type: 'string', required: true, allowed: ['a', 'b'] },
        note: { type: 'string', required: false },
      },
    };
    expect(displayedViolations('{"label":"b","id":"r1"}', rule)).toEqual([]);
    expect(displayedViolations('{"id":"r1","label":"a","note":"x"}', rule)).toEqual([]);
    expect(displayedViolations('{"id":"r2","label":"a"}', rule)).toEqual([
      'object.id should equal "r1"',
    ]);
    expect(displayedViolations('{"id":"r1"}', rule)).toEqual(['object.label is missing']);
    expect(displayedViolations('{"id":"r1","label":"a","extra":1}', rule)).toEqual([
      'object.extra is not in the contract',
    ]);
    expect(displayedViolations('not json', rule)).toHaveLength(1);
  });
});

describe('valueViolations', () => {
  it('reports every problem, not just the first', () => {
    expect(
      valueViolations('toolong', { type: 'string', required: true, maxLength: 3, allowed: ['a'] }),
    ).toHaveLength(2);
  });
});
