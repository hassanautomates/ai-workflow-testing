import { type Locator, type Page, expect } from '@playwright/test';
import { assertExact } from './assertions.ts';
import { HarnessError } from './errors.ts';
import { Mirror, type MirrorFetch, type Screen } from './mirror.ts';
import type { Case, DetailsStep, FormStep, TableStep, Workflow } from './workflow.ts';

// Drives one case of one workflow through the real UI, screen by screen,
// checking each screen against the mirror's prediction.
//
// Elements are located only by data-step-id, data-field and data-action.
// The page's <main> also carries data-workflow-id and data-run-status, which
// say which workflow is on screen and whether the run has ended.

/** A workflow with more screens than this is assumed to be looping. */
const MAX_SCREENS = 100;

const attr = (name: string, value: string) => `[${name}=${JSON.stringify(value)}]`;

function stepRoot(page: Page, stepId: string): Locator {
  return page.locator(attr('data-step-id', stepId));
}

/** Waits until the app shows the predicted screen; fails with both sides named if it doesn't. */
async function expectScreen(page: Page, workflow: Workflow, screen: Screen): Promise<void> {
  const main = page.locator('main[data-workflow-id]');
  await expect(main).toHaveAttribute('data-workflow-id', workflow.id);
  switch (screen.kind) {
    case 'step':
      await expect(main, 'app should show the mirrored step').toHaveAttribute(
        'data-step-id',
        screen.step.id,
      );
      await expect(main).toHaveAttribute('data-run-status', 'in-progress');
      return;
    case 'complete':
      await expect(main, 'app should have completed the run').toHaveAttribute(
        'data-run-status',
        'complete',
      );
      return;
    case 'error':
      await expect(main, `app should have failed the run: ${screen.reason}`).toHaveAttribute(
        'data-run-status',
        'error',
      );
      return;
  }
}

async function fillForm(page: Page, step: FormStep, inputs: Record<string, string>) {
  const root = stepRoot(page, step.id);
  for (const field of step.fields) {
    const value = inputs[field.name];
    if (value !== undefined) await root.locator(attr('data-field', field.name)).fill(value);
  }
  await root.locator(attr('data-action', 'submit')).click();
}

async function checkDetails(page: Page, mirror: Mirror, step: DetailsStep) {
  const root = stepRoot(page, step.id);
  for (const field of step.fields) {
    await assertExact(root.locator(attr('data-field', field.path)), mirror.expected(field.path));
  }
}

async function checkTable(page: Page, mirror: Mirror, step: TableStep) {
  const root = stepRoot(page, step.id);
  const rows = mirror.expected(step.rows).value;
  if (!Array.isArray(rows)) throw new HarnessError(`mirror's "${step.rows}" is not a list`);
  // Exactly the predicted cells: none missing, none extra.
  await expect(root.locator(`[data-field^=${JSON.stringify(`${step.rows}.`)}]`)).toHaveCount(
    rows.length * step.columns.length,
  );
  for (let i = 0; i < rows.length; i++) {
    for (const column of step.columns) {
      const path = `${step.rows}.${String(i)}.${column.key}`;
      await assertExact(root.locator(attr('data-field', path)), mirror.expected(path));
    }
  }
}

export async function driveCase(
  page: Page,
  workflow: Workflow,
  testCase: Case,
  fetchJson: MirrorFetch,
): Promise<void> {
  const mirror = await Mirror.start(workflow, fetchJson);
  await page.goto(`/run/${encodeURIComponent(workflow.id)}`);

  for (let screens = 0; screens < MAX_SCREENS; screens++) {
    const screen = mirror.screen;
    await expectScreen(page, workflow, screen);
    if (screen.kind !== 'step') return;

    const { step } = screen;
    const inputs = testCase.inputs[step.id] ?? {};
    switch (step.block) {
      case 'form':
        await fillForm(page, step, inputs);
        break;
      case 'details':
        await checkDetails(page, mirror, step);
        await stepRoot(page, step.id).locator(attr('data-action', 'continue')).click();
        break;
      case 'table':
        await checkTable(page, mirror, step);
        await stepRoot(page, step.id).locator(attr('data-action', 'continue')).click();
        break;
    }
    await mirror.submit(inputs);
  }
  throw new HarnessError(`more than ${String(MAX_SCREENS)} screens; is the workflow looping?`);
}
