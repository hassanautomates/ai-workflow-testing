import type { Locator } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { assertExact, assertShape } from '../../../harness/assertions.ts';
import type { Expected } from '../../../harness/mirror.ts';

/** Just enough of a Locator for the assertions, which only read raw text. */
function showing(text: string): Locator {
  return { textContent: () => Promise.resolve(text) } as unknown as Locator;
}

const total: Expected = {
  path: 'total',
  tainted: false,
  value: 64.92,
  rule: { type: 'exact', required: true, value: 64.92 },
  origin: 'mirrored',
};

const amount: Expected = {
  path: 'amount',
  tainted: true,
  value: undefined,
  rule: { type: 'number', required: true, min: 0, max: 100 },
  origin: 'ai "x" → amount',
};

describe('assertExact', () => {
  it('passes on exactly the predicted text', async () => {
    await expect(assertExact(showing('64.92'), total)).resolves.toBeUndefined();
  });

  it('fails on whitespace a whitespace-normalising check would ignore', async () => {
    await expect(assertExact(showing('\n  64.92\n'), total)).rejects.toThrow(
      'should show the mirrored value',
    );
    await expect(assertExact(showing('64.92 '), total)).rejects.toThrow();
  });
});

describe('exact is never looser than shape', () => {
  it('rejects the same padded text that a shape check rejects', async () => {
    await expect(assertShape(showing('\n42\n'), amount)).rejects.toThrow(
      'breaks its declared shape',
    );
    await expect(
      assertExact(showing('\n42\n'), {
        ...total,
        value: 42,
        rule: { type: 'exact', required: true, value: 42 },
      }),
    ).rejects.toThrow();
  });
});
