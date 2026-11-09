import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { HarnessError } from './errors.ts';
import { caseSlug } from './manifest.ts';

// The naive baseline, used only by `npm run prove` to show what taint
// tracking buys. It behaves like a fixture-based suite: one recording run
// (HARNESS_MODE=naive-record) saves what the app showed for every value the
// model produced, and every later run (HARNESS_MODE=naive) asserts those
// values exactly, including which branch a model-driven condition took.
// It never touches assertExact, which still refuses tainted values.

export type HarnessMode = 'taint' | 'naive-record' | 'naive';

export function harnessMode(env: NodeJS.ProcessEnv = process.env): HarnessMode {
  const mode = env.HARNESS_MODE?.trim() ?? '';
  if (mode === '' || mode === 'taint') return 'taint';
  if (mode === 'naive' || mode === 'naive-record') return mode;
  throw new HarnessError(`unknown HARNESS_MODE "${mode}"; expected taint, naive or naive-record`);
}

export const fixturesDir = resolve('reports', 'naive-fixtures');

export interface NaiveFixture {
  workflow: string;
  case: string;
  /** The seed the fixture was recorded with. */
  aiSeed: string;
  /** Screen number → the screen a model-driven branch led to. */
  routes: Record<string, string>;
  /** "<screen number> <element>" → the text shown, or null if it was marked absent. */
  values: Record<string, string | null>;
}

const key = (seq: number, element: string) => `${String(seq)} ${element}`;

/** Recorded values for one case: saved in record mode, enforced in naive mode. */
export class Fixture {
  private constructor(
    readonly mode: 'naive-record' | 'naive',
    private readonly data: NaiveFixture,
  ) {}

  static recording(workflow: string, caseName: string, aiSeed: string): Fixture {
    return new Fixture('naive-record', {
      workflow,
      case: caseName,
      aiSeed,
      routes: {},
      values: {},
    });
  }

  static async load(workflow: string, caseName: string, dir = fixturesDir): Promise<Fixture> {
    const path = join(dir, workflow, `${caseSlug(caseName)}.json`);
    try {
      return new Fixture('naive', JSON.parse(await readFile(path, 'utf8')) as NaiveFixture);
    } catch {
      throw new HarnessError(
        `no naive fixture at ${path}; record one with HARNESS_MODE=naive-record`,
      );
    }
  }

  get recordedSeed(): string {
    return this.data.aiSeed;
  }

  route(seq: number): string | undefined {
    return this.data.routes[String(seq)];
  }

  value(seq: number, element: string): string | null | undefined {
    return this.data.values[key(seq, element)];
  }

  saveRoute(seq: number, screen: string): void {
    this.data.routes[String(seq)] = screen;
  }

  saveValue(seq: number, element: string, text: string | null): void {
    this.data.values[key(seq, element)] = text;
  }

  async write(dir = fixturesDir): Promise<void> {
    const folder = join(dir, this.data.workflow);
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, `${caseSlug(this.data.case)}.json`),
      `${JSON.stringify(this.data, null, 2)}\n`,
    );
  }
}
