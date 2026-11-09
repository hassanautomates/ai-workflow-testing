import { type Locator, expect } from '@playwright/test';
import type { Expected } from './mirror.ts';
import { displayText } from './values.ts';

/**
 * The element shows exactly the value the mirror predicted. Only for values
 * the mirror computed itself; from Milestone 4 this refuses tainted values.
 */
export async function assertExact(element: Locator, expected: Expected): Promise<void> {
  await expect(element, `"${expected.path}" should show the mirrored value`).toHaveText(
    displayText(expected.value),
  );
}
