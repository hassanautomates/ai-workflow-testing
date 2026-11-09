import { type Locator, type Page, expect, test } from '@playwright/test';
import { assertExact, assertShape } from './assertions.ts';
import { HarnessError } from './errors.ts';
import type { CoverageRecorder } from './manifest.ts';
import { type Expected, Mirror, type MirrorFetch, type Screen, screenKey } from './mirror.ts';
import type { Case, DetailsStep, FormStep, TableStep, Workflow } from './workflow.ts';

// Drives one case of one workflow through the real UI, screen by screen,
// checking each screen against the mirror's prediction and recording what it
// did in the coverage manifest.
//
// Elements are located only by data-step-id, data-field and data-action.
// The page's <main> also carries data-workflow-id, data-run-status,
// data-screen-seq and data-error-code, which say which screen is showing,
// and an element whose optional value is missing carries data-absent.

/** A workflow with more screens than this is assumed to be looping. */
const MAX_SCREENS = 100;

const attr = (name: string, value: string) => `[${name}=${JSON.stringify(value)}]`;
const field = (path: string) => attr('data-field', path);
const action = (name: string) => attr('data-action', name);

interface Context {
  page: Page;
  mirror: Mirror;
  record: CoverageRecorder;
}

function stepRoot(page: Page, stepId: string): Locator {
  return page.locator(attr('data-step-id', stepId));
}

/** Exact for clean values, shape for tainted ones; recorded either way. */
async function check(ctx: Context, root: Locator, expected: Expected): Promise<void> {
  const element = field(expected.path);
  if (expected.tainted) {
    ctx.record.asserted({ kind: 'shape', element, rule: expected.rule, origin: expected.origin });
    await assertShape(root.locator(element), expected);
  } else {
    ctx.record.asserted({
      kind: 'exact',
      element,
      expected: expected.value,
      origin: expected.origin,
    });
    await assertExact(root.locator(element), expected);
  }
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

async function fillForm(ctx: Context, step: FormStep, inputs: Record<string, string>) {
  const root = stepRoot(ctx.page, step.id);
  for (const input of step.fields) {
    const value = inputs[input.name];
    if (value === undefined) {
      ctx.record.gap(field(input.name), 'form input this case leaves empty');
      continue;
    }
    ctx.record.drove(field(input.name), 'fill', value);
    await root.locator(field(input.name)).fill(value);
  }
}

async function checkDetails(ctx: Context, step: DetailsStep) {
  const root = stepRoot(ctx.page, step.id);
  for (const shown of step.fields) {
    if (!shown.optional) {
      await check(ctx, root, ctx.mirror.expected(shown.path));
      continue;
    }
    const element = root.locator(field(shown.path));
    const known = ctx.mirror.presence(shown.path);
    if (known.presence === 'absent') {
      ctx.record.asserted({ kind: 'absent', element: field(shown.path), origin: 'mirrored' });
      await expect(element, `"${shown.path}" should be marked absent`).toHaveAttribute(
        'data-absent',
        '',
      );
      continue;
    }
    await expect(element, `"${shown.path}" should be on the page`).toBeAttached();
    const absent = (await element.getAttribute('data-absent')) !== null;
    if (absent && known.presence === 'maybe') {
      // The model decides whether an optional field appears. This run it
      // didn't, so there is nothing to check; say so instead of passing quietly.
      ctx.record.gap(
        field(shown.path),
        `optional model field not returned with AI_SEED=${ctx.record.aiSeed}; its shape is unchecked in this run`,
      );
      continue;
    }
    expect(absent, `"${shown.path}" should have a value`).toBe(false);
    await check(ctx, root, known.expected);
  }
}

async function checkTable(ctx: Context, step: TableStep) {
  const root = stepRoot(ctx.page, step.id);
  const count = ctx.mirror.rowCount(step.rows);
  if (count === undefined) {
    await expect(root.locator(field(step.rows))).toBeAttached();
    ctx.record.gap(
      field(step.rows),
      'rows came from the model, so their number and contents are not predicted',
    );
    return;
  }
  // Exactly the predicted cells: none missing, none extra.
  ctx.record.asserted({
    kind: 'count',
    element: field(step.rows),
    expected: count * step.columns.length,
    origin: 'mirrored',
  });
  await expect(root.locator(`[data-field^=${JSON.stringify(`${step.rows}.`)}]`)).toHaveCount(
    count * step.columns.length,
  );
  for (let i = 0; i < count; i++) {
    for (const column of step.columns) {
      // Field-level taint: a model-written cell gets a shape check, its clean
      // neighbours in the same row are still compared exactly.
      await check(ctx, root, ctx.mirror.expected(`${step.rows}.${String(i)}.${column.key}`));
    }
  }
}

/** Anything on screen with a data-field that this screen didn't drive or assert is a gap. */
async function recordUntouched(ctx: Context, main: Locator): Promise<void> {
  const shown: string[] = [];
  for (const element of await main.locator('[data-field]').all()) {
    shown.push((await element.getAttribute('data-field')) ?? '');
  }
  ctx.record.untouched(
    shown.map(field),
    'on screen but not described by the workflow, so nothing is expected of it',
  );
}

async function press(ctx: Context, stepId: string, name: 'submit' | 'continue') {
  ctx.record.drove(action(name), 'click');
  await stepRoot(ctx.page, stepId).locator(action(name)).click();
}

export async function driveCase(
  page: Page,
  workflow: Workflow,
  testCase: Case,
  fetchJson: MirrorFetch,
  record: CoverageRecorder,
): Promise<void> {
  const mirror = await Mirror.start(workflow, fetchJson);
  const ctx: Context = { page, mirror, record };
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

    let observedFrom: string[] | undefined;
    if (mirror.options.length > 1) {
      // Observed routing: a condition read model output, so the mirror can't
      // say which branch the app took. Read what it rendered, check that it is
      // one of the branches the workflow allows, and follow that branch.
      const rendered = await renderedKey(main);
      observedFrom = mirror.options.map(screenKey);
      expect(observedFrom, `app rendered "${rendered}"; the workflow only allows these`).toContain(
        rendered,
      );
      mirror.observe(rendered);
      test.info().annotations.push({
        type: 'observed-route',
        description: `screen ${String(seq)}: ${rendered} (valid: ${observedFrom.join(', ')})`,
      });
      console.log(
        `observed route: screen ${String(seq)} → ${rendered} (valid: ${observedFrom.join(' | ')})`,
      );
    }

    const screen = mirror.screen;
    record.screen(seq, screenKey(screen), observedFrom);
    record.asserted({
      kind: 'screen',
      element: 'main',
      expected: screenKey(screen),
      origin: observedFrom ? 'observed routing' : 'mirrored',
    });
    await expectScreen(main, screen);
    if (screen.kind !== 'step') {
      await recordUntouched(ctx, main);
      return;
    }

    const { step } = screen;
    const inputs = testCase.inputs[step.id] ?? {};
    switch (step.block) {
      case 'form':
        await fillForm(ctx, step, inputs);
        await recordUntouched(ctx, main);
        await press(ctx, step.id, 'submit');
        break;
      case 'details':
        await checkDetails(ctx, step);
        await recordUntouched(ctx, main);
        await press(ctx, step.id, 'continue');
        break;
      case 'table':
        await checkTable(ctx, step);
        await recordUntouched(ctx, main);
        await press(ctx, step.id, 'continue');
        break;
    }
    await mirror.submit(inputs);
  }
  throw new HarnessError(`more than ${String(MAX_SCREENS)} screens; is the workflow looping?`);
}
