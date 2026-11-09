import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CoverageRecorder,
  type Manifest,
  caseSlug,
  readManifests,
  renderSummary,
  writeSummary,
} from '../../../harness/manifest.ts';

function sampleRecorder(): CoverageRecorder {
  const record = new CoverageRecorder('wf', 'Under 100, no discount', '42');
  record.screen(1, 'step:form');
  record.drove('[data-field="qty"]', 'fill', '3');
  record.untouched(['[data-field="qty"]', '[data-field="note"]'], 'not described');
  record.drove('[data-action="submit"]', 'click');
  record.screen(2, 'step:show', ['step:show', 'step:other']);
  record.asserted({
    kind: 'exact',
    element: '[data-field="total"]',
    expected: 5,
    origin: 'mirrored',
  });
  record.asserted({
    kind: 'shape',
    element: '[data-field="label"]',
    rule: { type: 'string', required: true },
    origin: 'ai "x" → label',
  });
  record.gap('[data-field="due"]', 'optional model field not returned');
  return record;
}

describe('CoverageRecorder', () => {
  it('records screens, driven elements, assertions and gaps per screen', () => {
    const manifest = sampleRecorder().manifest('passed');
    expect(manifest).toMatchObject({
      workflow: 'wf',
      case: 'Under 100, no discount',
      aiSeed: '42',
    });
    expect(manifest.screens).toEqual([
      { seq: 1, screen: 'step:form' },
      { seq: 2, screen: 'step:show', observedFrom: ['step:show', 'step:other'] },
    ]);
    expect(manifest.driven.map((d) => [d.screen, d.action, d.element])).toEqual([
      ['step:form', 'fill', '[data-field="qty"]'],
      ['step:form', 'click', '[data-action="submit"]'],
    ]);
    expect(manifest.assertions.map((a) => [a.screen, a.kind])).toEqual([
      ['step:show', 'exact'],
      ['step:show', 'shape'],
    ]);
  });

  it('turns only elements nobody drove or asserted into gaps', () => {
    const { gaps } = sampleRecorder().manifest('passed');
    expect(gaps).toEqual([
      { screen: 'step:form', element: '[data-field="note"]', reason: 'not described' },
      {
        screen: 'step:show',
        element: '[data-field="due"]',
        reason: 'optional model field not returned',
      },
    ]);
  });

  it('writes reports/manifest/<workflow>/<case>.json and reads it back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'manifest-'));
    const path = await sampleRecorder().write('failed', dir);
    expect(path).toBe(join(dir, 'wf', 'under-100-no-discount.json'));
    const [read] = await readManifests(dir);
    expect(read).toMatchObject({ workflow: 'wf', result: 'failed' });
  });
});

describe('summary', () => {
  const manifests: Manifest[] = [
    sampleRecorder().manifest('passed'),
    { ...sampleRecorder().manifest('failed'), case: 'second' },
    { ...new CoverageRecorder('alpha', 'only', '42').manifest('passed') },
  ];

  it('gives totals per workflow and overall', () => {
    const summary = renderSummary(manifests);
    expect(summary).toContain('AI_SEED: 42');
    expect(summary).toContain('| alpha | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |');
    expect(summary).toContain('| wf | 2 | 1 | 4 | 4 | 2 | 2 | 0 | 4 |');
    expect(summary).toContain('| **Total** | 3 | 2 | 4 | 4 | 2 | 2 | 0 | 4 |');
  });

  it('lists every gap with its reason', () => {
    expect(renderSummary(manifests)).toContain(
      '- wf › Under 100, no discount › step:show › `[data-field="due"]`: optional model field not returned',
    );
    expect(renderSummary([])).toContain('None.');
  });

  it('is written next to the manifests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'manifest-'));
    await sampleRecorder().write('passed', dir);
    expect(await writeSummary(dir)).toBe(join(dir, 'summary.md'));
    // The summary file itself is not mistaken for a manifest.
    expect(await readManifests(dir)).toHaveLength(1);
  });
});

describe('caseSlug', () => {
  it('makes file-safe names', () => {
    expect(caseSlug('100 or more, 10% discount')).toBe('100-or-more-10-discount');
    expect(caseSlug('!!!')).toBe('case');
  });
});
