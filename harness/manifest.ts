import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ShapeRule } from './shape.ts';

// The coverage manifest records, per case, what the test actually did: the
// screens it saw, every element it drove, every assertion (exact or shape)
// and every gap (something on screen it did not assert, and why). It is the
// evidence behind "this workflow is covered".

export const manifestDir = resolve('reports', 'manifest');

export interface ScreenRecord {
  seq: number;
  screen: string;
  /** Present when the screen was chosen by observed routing. */
  observedFrom?: string[];
}

export interface DrivenRecord {
  screen: string;
  element: string;
  action: 'fill' | 'click';
  value?: string;
}

export type AssertionRecord = { screen: string; element: string; origin: string } & (
  | { kind: 'exact'; expected: unknown }
  | { kind: 'shape'; rule: ShapeRule }
  /** The app marked an optional value as missing, as the mirror predicted. */
  | { kind: 'absent' }
  /** The number of elements, e.g. table cells. */
  | { kind: 'count'; expected: number }
  /** Which screen the app showed (step, completion, or error code). */
  | { kind: 'screen'; expected: string }
);

/** Omit<T, 'screen'> applied to each member of a union, so each kind keeps its own fields. */
type WithoutScreen<T> = T extends unknown ? Omit<T, 'screen'> : never;

export interface GapRecord {
  screen: string;
  element: string;
  reason: string;
}

export interface Manifest {
  workflow: string;
  case: string;
  aiSeed: string;
  result: 'passed' | 'failed';
  screens: ScreenRecord[];
  driven: DrivenRecord[];
  assertions: AssertionRecord[];
  gaps: GapRecord[];
}

/** File-safe name for a case: "100 or more, 10% discount" → "100-or-more-10-discount". */
export function caseSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'case'
  );
}

/** Collects one case's coverage as the driver goes. */
export class CoverageRecorder {
  private current = '';
  private readonly screens: ScreenRecord[] = [];
  private readonly driven: DrivenRecord[] = [];
  private readonly assertions: AssertionRecord[] = [];
  private readonly gaps: GapRecord[] = [];
  /** Elements on the current screen the test drove or asserted. */
  private touched = new Set<string>();

  constructor(
    readonly workflow: string,
    readonly caseName: string,
    readonly aiSeed: string,
  ) {}

  screen(seq: number, screen: string, observedFrom?: string[]): void {
    this.current = screen;
    this.touched = new Set();
    this.screens.push(observedFrom ? { seq, screen, observedFrom } : { seq, screen });
  }

  drove(element: string, action: DrivenRecord['action'], value?: string): void {
    this.touched.add(element);
    this.driven.push(
      value === undefined
        ? { screen: this.current, element, action }
        : { screen: this.current, element, action, value },
    );
  }

  asserted(record: WithoutScreen<AssertionRecord>): void {
    this.touched.add(record.element);
    this.assertions.push({ ...record, screen: this.current });
  }

  gap(element: string, reason: string): void {
    this.touched.add(element);
    this.gaps.push({ screen: this.current, element, reason });
  }

  /** Every element on screen that was neither driven nor asserted becomes a gap. */
  untouched(elements: readonly string[], reason: string): void {
    for (const element of elements) if (!this.touched.has(element)) this.gap(element, reason);
  }

  manifest(result: Manifest['result']): Manifest {
    return {
      workflow: this.workflow,
      case: this.caseName,
      aiSeed: this.aiSeed,
      result,
      screens: this.screens,
      driven: this.driven,
      assertions: this.assertions,
      gaps: this.gaps,
    };
  }

  /** Writes reports/manifest/<workflow>/<case>.json and returns its path. */
  async write(result: Manifest['result'], dir = manifestDir): Promise<string> {
    const folder = join(dir, this.workflow);
    await mkdir(folder, { recursive: true });
    const path = join(folder, `${caseSlug(this.caseName)}.json`);
    await writeFile(path, `${JSON.stringify(this.manifest(result), null, 2)}\n`);
    return path;
  }
}

/** Removes manifests from earlier runs, so the summary only reflects this one. */
export async function clearManifests(dir = manifestDir): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function readManifests(dir = manifestDir): Promise<Manifest[]> {
  let workflows: string[];
  try {
    workflows = await readdir(dir);
  } catch {
    return [];
  }
  const manifests: Manifest[] = [];
  for (const workflow of workflows.sort()) {
    let files: string[];
    try {
      files = (await readdir(join(dir, workflow))).filter((file) => file.endsWith('.json'));
    } catch {
      continue; // summary.md and other plain files
    }
    for (const file of files.sort()) {
      manifests.push(JSON.parse(await readFile(join(dir, workflow, file), 'utf8')) as Manifest);
    }
  }
  return manifests;
}

const count = (manifests: readonly Manifest[], pick: (m: Manifest) => number) =>
  manifests.reduce((sum, manifest) => sum + pick(manifest), 0);

/** summary.md: totals per workflow, then every gap with its reason. */
export function renderSummary(manifests: readonly Manifest[]): string {
  const workflows = [...new Set(manifests.map((manifest) => manifest.workflow))].sort();
  const seeds = [...new Set(manifests.map((manifest) => manifest.aiSeed))];
  const row = (name: string, group: readonly Manifest[]) =>
    `| ${name} | ${String(group.length)} | ${String(group.filter((m) => m.result === 'passed').length)} | ` +
    `${String(count(group, (m) => m.screens.length))} | ${String(count(group, (m) => m.driven.length))} | ` +
    `${String(count(group, (m) => m.assertions.filter((a) => a.kind === 'exact').length))} | ` +
    `${String(count(group, (m) => m.assertions.filter((a) => a.kind === 'shape').length))} | ` +
    `${String(count(group, (m) => m.assertions.filter((a) => a.kind !== 'exact' && a.kind !== 'shape').length))} | ` +
    `${String(count(group, (m) => m.gaps.length))} |`;

  const lines = [
    '# Coverage summary',
    '',
    `AI_SEED: ${seeds.length > 0 ? seeds.join(', ') : 'none'}`,
    '',
    '| Workflow | Cases | Passed | Screens | Elements driven | Exact | Shape | Other checks | Gaps |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...workflows.map((workflow) =>
      row(
        workflow,
        manifests.filter((manifest) => manifest.workflow === workflow),
      ),
    ),
    row('**Total**', manifests),
    '',
    '"Other checks" are screen identity, table cell counts and optional values the app marked absent.',
    '',
    '## Gaps',
    '',
  ];
  const gaps = manifests.flatMap((manifest) =>
    manifest.gaps.map(
      (gap) =>
        `- ${manifest.workflow} › ${manifest.case} › ${gap.screen} › \`${gap.element}\`: ${gap.reason}`,
    ),
  );
  lines.push(...(gaps.length > 0 ? gaps : ['None.']), '');
  return lines.join('\n');
}

export async function writeSummary(dir = manifestDir): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'summary.md');
  await writeFile(path, renderSummary(await readManifests(dir)));
  return path;
}
