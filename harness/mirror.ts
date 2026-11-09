import { HarnessError } from './errors.ts';
import {
  type MirrorState,
  assign,
  displayText,
  fill,
  lookup,
  roundHalfAwayFromZero,
} from './values.ts';
import {
  type HeadlessStep,
  type Operand,
  type Step,
  type UiStep,
  type Workflow,
  isUiStep,
} from './workflow.ts';

// The mirror replays a workflow's headless blocks test-side to predict what
// the app should show on each screen. It re-implements math, string, object,
// condition and fetch from the workflow definition alone; it never calls into
// the engine.

/** What the app should be showing right now. */
export type Screen =
  | { kind: 'step'; step: UiStep }
  | { kind: 'complete' }
  /** The app should have ended the run with an error page. */
  | { kind: 'error'; reason: string };

/** A value the mirror predicts for a state path. */
export interface Expected {
  readonly path: string;
  readonly value: unknown;
}

export interface FetchResult {
  status: number;
  body: unknown;
}

/** GET a path on the app's mock API. Fetch is mirrored by replaying the request. */
export type MirrorFetch = (path: string) => Promise<FetchResult>;

/**
 * The workflow would make the app end the run with an error (missing value,
 * wrong type, failed fetch). The mirror predicts an error screen rather than
 * failing the test, because that is what the app should do.
 */
class PredictedRunError extends Error {}

/** Mirrors the app's guard against a headless loop with no UI step. */
const MAX_HEADLESS_HOPS = 1000;

function readOrPredictError(state: MirrorState, path: string): unknown {
  const found = lookup(state, path);
  if (!found.found) throw new PredictedRunError(`state has no value at "${path}"`);
  return found.value;
}

function resolve(state: MirrorState, operand: Operand): unknown {
  return typeof operand === 'object' && operand !== null
    ? readOrPredictError(state, operand.ref)
    : operand;
}

function asNumber(step: Step, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PredictedRunError(`step "${step.id}" expected a number`);
  }
  return value;
}

function asString(step: Step, value: unknown): string {
  if (typeof value !== 'string') throw new PredictedRunError(`step "${step.id}" expected a string`);
  return value;
}

function asRecord(step: Step, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PredictedRunError(`step "${step.id}" expected an object`);
  }
  return value as Record<string, unknown>;
}

const arithmetic = {
  add: (a: number, b: number) => a + b,
  sub: (a: number, b: number) => a - b,
  mul: (a: number, b: number) => a * b,
  div: (a: number, b: number) => a / b,
} as const;

const comparisons = {
  gt: (a: number, b: number) => a > b,
  gte: (a: number, b: number) => a >= b,
  lt: (a: number, b: number) => a < b,
  lte: (a: number, b: number) => a <= b,
} as const;

export class Mirror {
  private readonly state: MirrorState = {};
  private current: Screen = { kind: 'complete' };

  private constructor(
    private readonly workflow: Workflow,
    private readonly fetchJson: MirrorFetch,
  ) {}

  /** Starts a mirrored run and advances to the first screen. */
  static async start(workflow: Workflow, fetchJson: MirrorFetch): Promise<Mirror> {
    const mirror = new Mirror(workflow, fetchJson);
    await mirror.advanceFrom(0);
    return mirror;
  }

  get screen(): Screen {
    return this.current;
  }

  /** The predicted value at `path`. Asking for a value the mirror doesn't have is a harness bug. */
  expected(path: string): Expected {
    const found = lookup(this.state, path);
    if (!found.found) throw new HarnessError(`mirror has no value at "${path}"`);
    return { path, value: found.value };
  }

  /**
   * Applies what the user does on the current screen (form inputs, or just
   * pressing continue) and advances to the next screen.
   */
  async submit(inputs: Readonly<Record<string, string>> = {}): Promise<void> {
    const screen = this.current;
    if (screen.kind !== 'step') throw new HarnessError('submit called after the run ended');
    if (screen.step.block === 'form') this.applyForm(screen.step.id, screen.step.fields, inputs);
    await this.advanceFrom(this.indexAfter(screen.step));
  }

  private applyForm(
    stepId: string,
    fields: readonly { name: string; type: 'text' | 'number'; required: boolean }[],
    inputs: Readonly<Record<string, string>>,
  ): void {
    for (const field of fields) {
      const raw = inputs[field.name] ?? '';
      if (raw.trim() === '') {
        // A case must drive the happy path of every form it reaches.
        if (field.required)
          throw new HarnessError(`case leaves required "${stepId}.${field.name}" empty`);
        continue;
      }
      if (field.type === 'number') {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          throw new HarnessError(`case gives "${raw}" for number field "${stepId}.${field.name}"`);
        }
        assign(this.state, field.name, parsed);
      } else {
        assign(this.state, field.name, raw);
      }
    }
  }

  private indexAfter(step: Step, jumpTo?: string): number {
    const target = jumpTo ?? step.next;
    if (target === undefined) return this.workflow.steps.indexOf(step) + 1;
    const index = this.workflow.steps.findIndex((candidate) => candidate.id === target);
    if (index < 0) throw new HarnessError(`step "${step.id}" points at unknown step "${target}"`);
    return index;
  }

  private async advanceFrom(start: number): Promise<void> {
    try {
      let index = start;
      for (let hops = 0; ; hops++) {
        if (hops > MAX_HEADLESS_HOPS)
          throw new PredictedRunError('too many steps without a UI step');
        const step = this.workflow.steps[index];
        if (step === undefined) {
          this.current = { kind: 'complete' };
          return;
        }
        if (isUiStep(step)) {
          this.checkRenderable(step);
          this.current = { kind: 'step', step };
          return;
        }
        index = this.indexAfter(step, await this.runHeadless(step));
      }
    } catch (error) {
      if (!(error instanceof PredictedRunError)) throw error;
      this.current = { kind: 'error', reason: error.message };
    }
  }

  /** The app refuses to render a UI step whose values are missing; so must the mirror. */
  private checkRenderable(step: UiStep): void {
    if (step.block === 'details') {
      for (const field of step.fields) readOrPredictError(this.state, field.path);
    }
    if (step.block === 'table') {
      const rows = readOrPredictError(this.state, step.rows);
      if (!Array.isArray(rows)) throw new PredictedRunError(`"${step.rows}" is not a list`);
      rows.forEach((row, i) => {
        asRecord(step, row);
        for (const column of step.columns) {
          readOrPredictError(this.state, `${step.rows}.${String(i)}.${column.key}`);
        }
      });
    }
  }

  /** Runs one headless step. Returns the step id to jump to, if it branches. */
  private async runHeadless(step: HeadlessStep): Promise<string | undefined> {
    const value = (operand: Operand) => resolve(this.state, operand);

    switch (step.block) {
      case 'math': {
        const numbers = step.args.map((arg) => asNumber(step, value(arg)));
        if (step.op === 'div' && numbers.slice(1).includes(0)) {
          throw new PredictedRunError(`step "${step.id}" divides by zero`);
        }
        const [first = 0, ...rest] = numbers;
        const raw = rest.reduce(arithmetic[step.op], first);
        const result =
          step.decimals === undefined ? raw : roundHalfAwayFromZero(raw, step.decimals);
        assign(this.state, step.into, result);
        return undefined;
      }

      case 'string': {
        let result: string;
        if (step.op === 'template') {
          result = fill(step.template ?? '', (path) =>
            displayText(readOrPredictError(this.state, path)),
          );
        } else if (step.op === 'concat') {
          result = (step.args ?? []).map((arg) => displayText(value(arg))).join('');
        } else {
          if (step.args?.length !== 1)
            throw new PredictedRunError(`step "${step.id}" takes one arg`);
          const input = asString(step, value(step.args[0] ?? null));
          result = { upper: input.toUpperCase(), lower: input.toLowerCase(), trim: input.trim() }[
            step.op
          ];
        }
        assign(this.state, step.into, result);
        return undefined;
      }

      case 'object': {
        let result: unknown;
        if (step.op === 'set') {
          result = value(step.value);
        } else if (step.op === 'pick') {
          const source = asRecord(step, readOrPredictError(this.state, step.from));
          const picked: Record<string, unknown> = {};
          for (const field of step.fields) picked[field] = readOrPredictError(source, field);
          result = picked;
        } else {
          const merged: Record<string, unknown> = {};
          for (const path of step.sources) {
            Object.assign(merged, asRecord(step, readOrPredictError(this.state, path)));
          }
          result = merged;
        }
        assign(this.state, step.into, result);
        return undefined;
      }

      case 'condition': {
        const left = value(step.if.left);
        const right = value(step.if.right);
        const { cmp } = step.if;
        const holds =
          cmp === 'eq'
            ? left === right
            : cmp === 'ne'
              ? left !== right
              : comparisons[cmp](asNumber(step, left), asNumber(step, right));
        return holds ? step.then : step.else;
      }

      case 'fetch': {
        const path = fill(step.path, (ref) =>
          encodeURIComponent(displayText(readOrPredictError(this.state, ref))),
        );
        const response = await this.fetchJson(path);
        if (response.status !== 200) {
          throw new PredictedRunError(`GET ${path} returned ${String(response.status)}`);
        }
        assign(this.state, step.into, response.body);
        return undefined;
      }
    }
  }
}
