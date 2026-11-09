import { type Locator, expect } from '@playwright/test';
import { displayText } from './display.ts';
import { HarnessError } from './errors.ts';
import type { Expected } from './mirror.ts';
import { displayedViolations } from './shape.ts';

/**
 * The element shows exactly the value the mirror predicted.
 *
 * Refuses tainted values outright: the mirror doesn't know what a model
 * produced, so any exact comparison would be against a guess and would flake.
 * This is a harness error, not a test failure: the test itself is wrong.
 */
export async function assertExact(element: Locator, expected: Expected): Promise<void> {
  if (expected.tainted) {
    throw new HarnessError(
      `refusing to compare "${expected.path}" exactly: it is tainted (${expected.origin}); use assertShape`,
    );
  }
  await expect(element, `"${expected.path}" should show the mirrored value`).toHaveText(
    displayText(expected.value),
  );
}

/**
 * The element shows a value of the declared shape: type, required, length or
 * range bounds, allowed set. Never the exact text. The rules come from the
 * workflow JSON (an ai block's output contract, an id block's format) or are
 * derived from them; none are written into the harness.
 *
 * Refuses clean values: those must be checked exactly, not loosely.
 */
export async function assertShape(element: Locator, expected: Expected): Promise<void> {
  if (!expected.tainted) {
    throw new HarnessError(`"${expected.path}" is clean; check it with assertExact, not a shape`);
  }
  await expect(element, `"${expected.path}" should be on the page`).toBeAttached();
  const text = (await element.textContent()) ?? '';
  expect(
    displayedViolations(text, expected.rule),
    `"${expected.path}" (${expected.origin}) showed "${text}", which breaks its declared shape`,
  ).toEqual([]);
}
