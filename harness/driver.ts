import { type Locator, type Page, expect, test } from '@playwright/test';
import { assertExact, assertShape } from './assertions.ts';
import { HarnessError } from './errors.ts';
import { type Expected, Mirror, type MirrorFetch, type Screen, screenKey } from './mirror.ts';
import type { Case, DetailsStep, FormStep, TableStep, Workflow } from './workflow.ts';

// Drives one case of one workflow through the real UI, screen by screen,
// checking each screen against the mirror's prediction.
//
// Elements are located only by data-step-id, data-field and data-action.
// The page's <main> also carries data-workflow-id, data-run-status,
// data-screen-seq and data-error-code, which say which screen is showing.

/** A workflow with more screens than this is assumed to be looping. */
const MAX_SCREENS = 100;

const attr = (name: string, value: string) => `[${name}=${JSON.stringify(value)}]`;

function stepRoot(page: Page, stepId: string): Locator {
  return page.locator(attr('data-step-id', stepId));
}

/** Exact for clean values, shape for tainted ones. */
async function check(element: Locator, expected: Expected): Promise<void> {
  await (expected.tainted ? assertShape(element, expected) : assertExact(element, expected));
}

/** The screen the page is showing, named the same way as the mirror's screenKey(). */
async function renderedKey(main: Locator): Promise<string> {
  const status = await main.getAttribute('data-run-status');
  if (status === 'complete') return 'complete';
  if (status === 'error') return `error:${(await main.getAttribute('data-error-code')) ?? '?'}`;
  return `step:${(await main.getAttribute('data-step-id')) ?? '?'}`;
}

async function expectScreen(main: Locator, screen: Screen): Promise<void> {
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
      await expect(main, 'app should report why the run failed').toHaveAttribute(
        'data-error-code',
        screen.code,
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
    await check(root.locator(attr('data-field', field.path)), mirror.expected(field.path));
  }
}

async function checkTable(page: Page, mirror: Mirror, step: TableStep) {
  const root = stepRoot(page, step.id);
  const count = mirror.rowCount(step.rows);
  if (count === undefined) {
    // Model-derived rows: the count is unknown, so only the table's presence is checked.
    await expect(root.locator(attr('data-field', step.rows))).toBeAttached();
    return;
  }
  // Exactly the predicted cells: none missing, none extra.
  await expect(root.locator(`[data-field^=${JSON.stringify(`${step.rows}.`)}]`)).toHaveCount(
    count * step.columns.length,
  );
  for (let i = 0; i < count; i++) {
    for (const column of step.columns) {
      const path = `${step.rows}.${String(i)}.${column.key}`;
      // Field-level taint: a model-written cell gets a shape check, its clean
      // neighbours in the same row are still compared exactly.
      await check(root.locator(attr('data-field', path)), mirror.expected(path));
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
  const main = page.locator('main[data-workflow-id]');
  await page.goto(`/run/${encodeURIComponent(workflow.id)}`);

  for (let seq = 1; seq <= MAX_SCREENS; seq++) {
    // Wait for the app's own signal that the next screen is up, rather than
    // for a particular step: with observed routing we don't know which yet.
    await expect(main, `waiting for screen ${String(seq)}`).toHaveAttribute(
      'data-screen-seq',
      String(seq),
    );
    await expect(main).toHaveAttribute('data-workflow-id', workflow.id);

    if (mirror.options.length > 1) {
      // Observed routing: a condition read model output, so the mirror can't
      // say which branch the app took. Read what it rendered, check that it is
      // one of the branches the workflow allows, and follow that branch.
      const rendered = await renderedKey(main);
      const valid = mirror.options.map(screenKey);
      expect(valid, `app rendered "${rendered}"; the workflow only allows these`).toContain(
        rendered,
      );
      mirror.observe(rendered);
      test.info().annotations.push({
        type: 'observed-route',
        description: `screen ${String(seq)}: ${rendered} (valid: ${valid.join(', ')})`,
      });
      console.log(
        `observed route: screen ${String(seq)} → ${rendered} (valid: ${valid.join(' | ')})`,
      );
    }

    const screen = mirror.screen;
    await expectScreen(main, screen);
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
