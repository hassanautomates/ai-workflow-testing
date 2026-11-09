import { displayText } from './display.ts';
import { HarnessError } from './errors.ts';
import { type ShapeRule, Tainted, containsTaint, isRecord, shapeOf } from './shape.ts';
import {
  type MirrorState,
  assign,
  copyValue,
  fill,
  lookup,
  placeholders,
  roundHalfAwayFromZero,
} from './values.ts';
import {
  type ConditionStep,
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
//
// It does not re-implement ai or id. Their outputs are marked Tainted: known
// only by shape. Taint then spreads through anything computed from them, but
// only as far as the data actually flows: one model field in an object
// taints that field, not its siblings.

/** Why the app should end a run in an error. Matches data-error-code on the page. */
export type ErrorCode =
  'missing-value' | 'wrong-type' | 'bad-args' | 'divide-by-zero' | 'fetch-failed' | 'step-loop';

/** What the app should be showing. */
export type Screen =
  | { kind: 'step'; step: UiStep }
  | { kind: 'complete' }
  | { kind: 'error'; code: ErrorCode; reason: string };

/** A stable name for a screen, comparable with what the page renders. */
export function screenKey(screen: Screen): string {
  switch (screen.kind) {
    case 'step':
      return `step:${screen.step.id}`;
    case 'complete':
      return 'complete';
    case 'error':
      return `error:${screen.code}`;
  }
}

/** What the mirror predicts for one state path. */
export interface Expected {
  readonly path: string;
  /** Came from (or was computed from) model output or a random ID. Never compare it exactly. */
  readonly tainted: boolean;
  /** The exact value when clean; undefined when tainted, because the mirror doesn't know it. */
  readonly value: unknown;
  /** What the value must look like. For clean values, an exact rule. */
  readonly rule: ShapeRule;
  /** Where the value came from, for messages. */
  readonly origin: string;
}

export type OptionalExpected =
  { presence: 'absent' } | { presence: 'present' | 'maybe'; expected: Expected };

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
class PredictedRunError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** One way the run could have gone: the state it would have, and the screen it would show. */
interface World {
  state: MirrorState;
  screen: Screen;
}

/** Mirrors the app's guard against a headless loop with no UI step. */
const MAX_HEADLESS_HOPS = 1000;
/** More distinct possible screens than this means the workflow branches on model output too much to follow. */
const MAX_WORLDS = 64;

// --- reading values ------------------------------------------------------------

function readOrPredictError(state: MirrorState, path: string): unknown {
  const found = lookup(state, path);
  if (!found.found) throw new PredictedRunError('missing-value', `state has no value at "${path}"`);
  return found.value;
}

function resolve(state: MirrorState, operand: Operand): unknown {
  return typeof operand === 'object' && operand !== null
    ? readOrPredictError(state, operand.ref)
    : operand;
}

function asNumber(step: Step, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PredictedRunError('wrong-type', `step "${step.id}" expected a number`);
  }
  return value;
}

function asString(step: Step, value: unknown): string {
  if (typeof value !== 'string') {
    throw new PredictedRunError('wrong-type', `step "${step.id}" expected a string`);
  }
  return value;
}

/**
 * A tainted value used where the app needs a given type. If its declared
 * shape is some other type, the app is certain to fail, so predict that.
 */
function requireTaintedType(step: Step, value: Tainted, type: 'number' | 'string'): void {
  const { rule } = value;
  const fits =
    rule.type === type ||
    rule.type === 'any' ||
    (rule.type === 'exact' && typeof rule.value === type);
  if (!fits) {
    throw new PredictedRunError(
      'wrong-type',
      `step "${step.id}" expected a ${type} (${value.origin})`,
    );
  }
}

// --- shapes of derived values -------------------------------------------------

type Interval = readonly [number, number];

function intervalOf(step: Step, value: unknown): Interval {
  if (value instanceof Tainted) {
    requireTaintedType(step, value, 'number');
    const { rule } = value;
    if (rule.type === 'number') return [rule.min ?? -Infinity, rule.max ?? Infinity];
    if (rule.type === 'exact' && typeof rule.value === 'number') return [rule.value, rule.value];
    return [-Infinity, Infinity];
  }
  const number = asNumber(step, value);
  return [number, number];
}

/** Interval arithmetic: the range of `a op b` given ranges for a and b. */
function combine(op: 'add' | 'sub' | 'mul' | 'div', a: Interval, b: Interval): Interval {
  switch (op) {
    case 'add':
      return [a[0] + b[0], a[1] + b[1]];
    case 'sub':
      return [a[0] - b[1], a[1] - b[0]];
    case 'mul':
    case 'div': {
      if (op === 'div' && b[0] <= 0 && b[1] >= 0) return [-Infinity, Infinity];
      const apply =
        op === 'mul' ? (x: number, y: number) => x * y : (x: number, y: number) => x / y;
      // 0 × ∞ is NaN in floats; as a bound it means 0.
      const corners = [
        apply(a[0], b[0]),
        apply(a[0], b[1]),
        apply(a[1], b[0]),
        apply(a[1], b[1]),
      ].map((corner) => (Number.isNaN(corner) ? 0 : corner));
      return [Math.min(...corners), Math.max(...corners)];
    }
  }
}

function decimalPlaces(value: number): number {
  const text = String(value);
  return text.includes('e') ? 10 : (text.split('.')[1]?.length ?? 0);
}

/** The narrowest rule a single known value satisfies. */
function ruleForKnown(value: unknown): ShapeRule {
  if (value instanceof Tainted) return value.rule;
  if (containsTaint(value)) return shapeOf(value);
  if (typeof value === 'number') {
    return {
      type: 'number',
      required: true,
      min: value,
      max: value,
      decimals: decimalPlaces(value),
    };
  }
  if (typeof value === 'string') return { type: 'string', required: true, allowed: [value] };
  if (typeof value === 'boolean') return { type: 'boolean', required: true };
  return { type: 'exact', required: true, value };
}

const both = <T>(a: T | undefined, b: T | undefined, join: (x: T, y: T) => T): T | undefined =>
  a === undefined || b === undefined ? undefined : join(a, b);

/** The loosest rule that both rules' values satisfy. */
function unionRule(a: ShapeRule, b: ShapeRule): ShapeRule {
  const required = a.required && b.required;
  if (a.type === 'number' && b.type === 'number') {
    return {
      type: 'number',
      required,
      min: both(a.min, b.min, Math.min),
      max: both(a.max, b.max, Math.max),
      decimals: both(a.decimals, b.decimals, Math.max),
      allowed: both(a.allowed, b.allowed, (x, y) => [...new Set([...x, ...y])]),
    };
  }
  if (a.type === 'string' && b.type === 'string') {
    return {
      type: 'string',
      required,
      minLength: both(a.minLength, b.minLength, Math.min),
      maxLength: both(a.maxLength, b.maxLength, Math.max),
      allowed: both(a.allowed, b.allowed, (x, y) => [...new Set([...x, ...y])]),
      pattern: a.pattern === b.pattern ? a.pattern : undefined,
    };
  }
  if (a.type === 'boolean' && b.type === 'boolean') return { type: 'boolean', required };
  if (a.type === 'object' && b.type === 'object') {
    const fields: Record<string, ShapeRule> = {};
    for (const key of new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])) {
      const left = a.fields[key];
      const right = b.fields[key];
      fields[key] =
        left && right
          ? unionRule(left, right)
          : { ...(left ?? right ?? { type: 'any' }), required: false };
    }
    return { type: 'object', required, fields };
  }
  if (
    a.type === 'exact' &&
    b.type === 'exact' &&
    JSON.stringify(a.value) === JSON.stringify(b.value)
  ) {
    return a;
  }
  return { type: 'any', required };
}

/**
 * Two branches reached the same screen with possibly different state.
 * Anything that differs depends on which branch the model's output picked,
 * so it is model-derived: it becomes tainted, with a shape covering both.
 */
function mergeValues(a: unknown, b: unknown, origin: string): unknown {
  if (a === b) return a;
  if (a instanceof Tainted || b instanceof Tainted) {
    return new Tainted(unionRule(ruleForKnown(a), ruleForKnown(b)), origin);
  }
  if (isRecord(a) && isRecord(b)) {
    const merged: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const inA = Object.prototype.hasOwnProperty.call(a, key);
      const inB = Object.prototype.hasOwnProperty.call(b, key);
      merged[key] =
        inA && inB
          ? mergeValues(a[key], b[key], origin)
          : new Tainted({ ...ruleForKnown(inA ? a[key] : b[key]), required: false }, origin);
    }
    return merged;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.map((item, i) => mergeValues(item, b[i], origin));
  }
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  return new Tainted(unionRule(ruleForKnown(a), ruleForKnown(b)), origin);
}

function transformedStringRule(rule: ShapeRule, op: 'upper' | 'lower' | 'trim'): ShapeRule {
  if (rule.type !== 'string') return { type: 'string', required: rule.required };
  const map = {
    upper: (s: string) => s.toUpperCase(),
    lower: (s: string) => s.toLowerCase(),
    trim: (s: string) => s.trim(),
  }[op];
  return {
    type: 'string',
    required: rule.required,
    ...(op !== 'trim' && rule.minLength !== undefined ? { minLength: rule.minLength } : {}),
    ...(rule.maxLength !== undefined ? { maxLength: rule.maxLength } : {}),
    ...(rule.allowed ? { allowed: rule.allowed.map(map) } : {}),
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

type Comparison = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

/** `a cmp b` rewritten as `b cmp' a`. */
const flipped: Record<Comparison, Comparison> = {
  eq: 'eq',
  ne: 'ne',
  gt: 'lt',
  gte: 'lte',
  lt: 'gt',
  lte: 'gte',
};

/** The comparison that holds when `cmp` doesn't. */
const negated: Record<Comparison, Comparison> = {
  eq: 'ne',
  ne: 'eq',
  gt: 'lte',
  gte: 'lt',
  lt: 'gte',
  lte: 'gt',
};

/**
 * What a branch taught us about a tainted value: in the "then" branch of
 * `confidence >= 0.75`, the confidence must be at least 0.75. Narrowing the
 * shape this way means a later shape check catches the app taking the wrong
 * branch, not just an invalid one.
 */
function narrowRule(rule: ShapeRule, cmp: Comparison, bound: unknown): ShapeRule {
  if (rule.type === 'number' && typeof bound === 'number') {
    // Shapes only have inclusive bounds; with known decimals, a strict bound is one step in.
    const step = rule.decimals === undefined ? 0 : 10 ** -rule.decimals;
    const tighten = (min?: number, max?: number): ShapeRule => ({
      ...rule,
      min:
        min === undefined
          ? rule.min
          : Math.max(rule.min ?? -Infinity, roundHalfAwayFromZero(min, 10)),
      max:
        max === undefined
          ? rule.max
          : Math.min(rule.max ?? Infinity, roundHalfAwayFromZero(max, 10)),
    });
    switch (cmp) {
      case 'gt':
        return tighten(bound + step);
      case 'gte':
        return tighten(bound);
      case 'lt':
        return tighten(undefined, bound - step);
      case 'lte':
        return tighten(undefined, bound);
      case 'eq':
        return tighten(bound, bound);
      case 'ne':
        return rule;
    }
  }
  if (rule.type === 'string' && typeof bound === 'string') {
    if (cmp === 'eq') return { ...rule, allowed: [bound] };
    if (cmp === 'ne' && rule.allowed)
      return { ...rule, allowed: rule.allowed.filter((v) => v !== bound) };
  }
  return rule;
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

// --- the mirror -------------------------------------------------------------------

export class Mirror {
  /** Every screen the app could be showing now, each with the state that leads to it. */
  private worlds: World[] = [];

  private constructor(
    private readonly workflow: Workflow,
    private readonly fetchJson: MirrorFetch,
  ) {}

  /** Starts a mirrored run and advances to the first screen. */
  static async start(workflow: Workflow, fetchJson: MirrorFetch): Promise<Mirror> {
    const mirror = new Mirror(workflow, fetchJson);
    mirror.worlds = await mirror.settle({}, 0);
    return mirror;
  }

  /** The screens the app could validly be showing. More than one means a branch read model output. */
  get options(): Screen[] {
    return this.worlds.map((world) => world.screen);
  }

  /** The one screen the app should be showing. Call observe() first if there are several options. */
  get screen(): Screen {
    return this.only().screen;
  }

  /**
   * Observed routing: tell the mirror which screen the app actually rendered.
   * It must be one of the options; the mirror then continues from that branch.
   */
  observe(key: string): Screen {
    const match = this.worlds.find((world) => screenKey(world.screen) === key);
    if (!match) {
      throw new HarnessError(
        `app rendered "${key}", which is not one of the valid branches: ${this.optionKeys()}`,
      );
    }
    this.worlds = [match];
    return match.screen;
  }

  /**
   * For a value displayed as optional: whether it should be there at all.
   * "maybe" means it is an optional model field: the model decides, so the
   * mirror can't.
   */
  presence(path: string): OptionalExpected {
    const found = lookup(this.only().state, path);
    if (!found.found) return { presence: 'absent' };
    const expected = this.expected(path);
    const optional = found.value instanceof Tainted && !found.value.rule.required;
    return { presence: optional ? 'maybe' : 'present', expected };
  }

  /** What the app should show for `path` on the current screen. */
  expected(path: string): Expected {
    const found = lookup(this.only().state, path);
    if (!found.found) throw new HarnessError(`mirror has no value at "${path}"`);
    const { value } = found;
    if (value instanceof Tainted) {
      return { path, tainted: true, value: undefined, rule: value.rule, origin: value.origin };
    }
    if (containsTaint(value)) {
      return {
        path,
        tainted: true,
        value: undefined,
        rule: shapeOf(value),
        origin: 'partly model output',
      };
    }
    return {
      path,
      tainted: false,
      value,
      rule: { type: 'exact', required: true, value },
      origin: 'mirrored',
    };
  }

  /**
   * How many rows a list has. Known even when some cells are tainted;
   * undefined when the list itself came from the model.
   */
  rowCount(path: string): number | undefined {
    const found = lookup(this.only().state, path);
    if (!found.found) throw new HarnessError(`mirror has no value at "${path}"`);
    return Array.isArray(found.value) ? found.value.length : undefined;
  }

  /**
   * Applies what the user does on the current screen (form inputs, or just
   * pressing continue) and advances to the next screen(s).
   */
  async submit(inputs: Readonly<Record<string, string>> = {}): Promise<void> {
    const world = this.only();
    const { screen } = world;
    if (screen.kind !== 'step') throw new HarnessError('submit called after the run ended');
    if (screen.step.block === 'form')
      this.applyForm(world.state, screen.step.id, screen.step.fields, inputs);
    this.worlds = await this.settle(world.state, this.indexAfter(screen.step));
  }

  private only(): World {
    const [world, ...others] = this.worlds;
    if (!world || others.length > 0) {
      throw new HarnessError(
        `the app could be showing any of ${this.optionKeys()}; observe() the rendered screen first`,
      );
    }
    return world;
  }

  private optionKeys(): string {
    return this.worlds.map((world) => screenKey(world.screen)).join(', ');
  }

  private applyForm(
    state: MirrorState,
    stepId: string,
    fields: readonly { name: string; type: 'text' | 'textarea' | 'number'; required: boolean }[],
    inputs: Readonly<Record<string, string>>,
  ): void {
    for (const field of fields) {
      const raw = inputs[field.name] ?? '';
      if (raw.trim() === '') {
        // A case must drive the happy path of every form it reaches.
        if (field.required) {
          throw new HarnessError(`case leaves required "${stepId}.${field.name}" empty`);
        }
        continue;
      }
      if (field.type === 'number') {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          throw new HarnessError(`case gives "${raw}" for number field "${stepId}.${field.name}"`);
        }
        assign(state, field.name, parsed);
      } else {
        assign(state, field.name, raw);
      }
    }
  }

  private indexOf(step: Step, target: string): number {
    const index = this.workflow.steps.findIndex((candidate) => candidate.id === target);
    if (index < 0) throw new HarnessError(`step "${step.id}" points at unknown step "${target}"`);
    return index;
  }

  private indexAfter(step: Step): number {
    return step.next === undefined
      ? this.workflow.steps.indexOf(step) + 1
      : this.indexOf(step, step.next);
  }

  /** Explores from `start` and groups the outcomes by screen, merging same-screen states. */
  private async settle(state: MirrorState, start: number): Promise<World[]> {
    const outcomes = await this.explore(state, start, { hops: 0 });
    const byScreen = new Map<string, World>();
    for (const outcome of outcomes) {
      const key = screenKey(outcome.screen);
      const existing = byScreen.get(key);
      byScreen.set(
        key,
        existing
          ? {
              screen: existing.screen,
              state: mergeValues(
                existing.state,
                outcome.state,
                `differs by branch before "${key}"`,
              ) as MirrorState,
            }
          : outcome,
      );
    }
    if (byScreen.size > MAX_WORLDS) {
      throw new HarnessError(
        `more than ${String(MAX_WORLDS)} possible screens; too much branching on model output`,
      );
    }
    return [...byScreen.values()];
  }

  private async explore(
    state: MirrorState,
    start: number,
    budget: { hops: number },
  ): Promise<World[]> {
    let index = start;
    try {
      for (;;) {
        if (++budget.hops > MAX_HEADLESS_HOPS) {
          throw new PredictedRunError('step-loop', 'too many steps without a UI step');
        }
        const step = this.workflow.steps[index];
        if (step === undefined) return [{ state, screen: { kind: 'complete' } }];
        if (isUiStep(step)) {
          this.checkRenderable(state, step);
          return [{ state, screen: { kind: 'step', step } }];
        }
        if (step.block === 'condition') {
          const target = this.decide(step, state);
          if (target === undefined) {
            // Observed routing: this condition reads model output, so the mirror
            // can't know which way the app went. Follow both targets, each with
            // the model value narrowed by what that branch implies; the driver
            // reads the screen the app actually rendered and keeps that branch.
            const viaThen = await this.explore(
              this.narrowed(state, step, true),
              this.indexOf(step, step.then),
              budget,
            );
            const viaElse = await this.explore(
              this.narrowed(state, step, false),
              this.indexOf(step, step.else),
              budget,
            );
            return [...viaThen, ...viaElse];
          }
          index = this.indexOf(step, target);
          continue;
        }
        await this.runHeadless(step, state);
        index = this.indexAfter(step);
      }
    } catch (error) {
      if (!(error instanceof PredictedRunError)) throw error;
      return [{ state, screen: { kind: 'error', code: error.code, reason: error.message } }];
    }
  }

  /** The app refuses to render a UI step whose values are missing; so must the mirror. */
  private checkRenderable(state: MirrorState, step: UiStep): void {
    if (step.block === 'details') {
      // An optional field may be missing; the app then shows it as absent.
      for (const field of step.fields) if (!field.optional) readOrPredictError(state, field.path);
    }
    if (step.block === 'table') {
      const rows = readOrPredictError(state, step.rows);
      if (rows instanceof Tainted) return; // Model-derived rows: can't know how many.
      if (!Array.isArray(rows)) {
        throw new PredictedRunError('wrong-type', `"${step.rows}" is not a list`);
      }
      rows.forEach((row, i) => {
        if (!isRecord(row) && !(row instanceof Tainted)) {
          throw new PredictedRunError('wrong-type', `"${step.rows}.${String(i)}" is not an object`);
        }
        for (const column of step.columns) {
          readOrPredictError(state, `${step.rows}.${String(i)}.${column.key}`);
        }
      });
    }
  }

  /**
   * A copy of `state` for one branch of a condition on model output, with the
   * tainted side's shape narrowed by what that branch implies.
   */
  private narrowed(state: MirrorState, step: ConditionStep, holds: boolean): MirrorState {
    const copy = copyValue(state) as MirrorState;
    const cmp = holds ? step.if.cmp : negated[step.if.cmp];
    const sides = [
      { operand: step.if.left, other: step.if.right, cmp },
      { operand: step.if.right, other: step.if.left, cmp: flipped[cmp] },
    ];
    for (const side of sides) {
      if (typeof side.operand !== 'object' || side.operand === null) continue;
      const value = lookup(copy, side.operand.ref);
      const bound = resolve(copy, side.other);
      if (value.found && value.value instanceof Tainted && !containsTaint(bound)) {
        const narrowedRule = narrowRule(value.value.rule, side.cmp, bound);
        assign(copy, side.operand.ref, new Tainted(narrowedRule, value.value.origin));
      }
    }
    return copy;
  }

  /** The step id a condition jumps to, or undefined when it reads model output. */
  private decide(step: ConditionStep, state: MirrorState): string | undefined {
    const left = resolve(state, step.if.left);
    const right = resolve(state, step.if.right);
    const { cmp } = step.if;
    if (containsTaint(left) || containsTaint(right)) {
      if (cmp !== 'eq' && cmp !== 'ne') {
        // The app will still fail if either side can't be a number.
        for (const side of [left, right]) {
          if (side instanceof Tainted) requireTaintedType(step, side, 'number');
          else asNumber(step, side);
        }
      }
      return undefined;
    }
    const holds =
      cmp === 'eq'
        ? left === right
        : cmp === 'ne'
          ? left !== right
          : comparisons[cmp](asNumber(step, left), asNumber(step, right));
    return holds ? step.then : step.else;
  }

  /** Runs one headless step (not a condition) against `state`, in place. */
  private async runHeadless(
    step: Exclude<HeadlessStep, ConditionStep>,
    state: MirrorState,
  ): Promise<void> {
    const value = (operand: Operand) => resolve(state, operand);

    switch (step.block) {
      case 'math': {
        const args = step.args.map(value);
        if (step.op === 'div' && args.slice(1).some((arg) => arg === 0)) {
          throw new PredictedRunError('divide-by-zero', `step "${step.id}" divides by zero`);
        }
        if (args.some(containsTaint)) {
          // Computed from model output: the result is tainted, but its range
          // follows from the inputs' declared ranges.
          const [first, ...rest] = args.map((arg) => intervalOf(step, arg));
          const [low, high] = rest.reduce(
            (acc, next) => combine(step.op, acc, next),
            first ?? [0, 0],
          );
          const round = (bound: number) =>
            step.decimals === undefined ? bound : roundHalfAwayFromZero(bound, step.decimals);
          const rule: ShapeRule = {
            type: 'number',
            required: true,
            ...(Number.isFinite(low) ? { min: round(low) } : {}),
            ...(Number.isFinite(high) ? { max: round(high) } : {}),
            ...(step.decimals === undefined ? {} : { decimals: step.decimals }),
          };
          assign(state, step.into, new Tainted(rule, `math "${step.id}" on model output`));
          return;
        }
        const [first = 0, ...rest] = args.map((arg) => asNumber(step, arg));
        const raw = rest.reduce(arithmetic[step.op], first);
        assign(
          state,
          step.into,
          step.decimals === undefined ? raw : roundHalfAwayFromZero(raw, step.decimals),
        );
        return;
      }

      case 'string': {
        if (step.op === 'template' || step.op === 'concat') {
          const parts =
            step.op === 'template'
              ? placeholders(step.template ?? '').map(
                  (path) => [path, readOrPredictError(state, path)] as const,
                )
              : (step.args ?? []).map((arg, i) => [String(i), value(arg)] as const);
          const known = new Map(parts);
          const render = (part: unknown) => (containsTaint(part) ? '' : displayText(part));
          const text =
            step.op === 'template'
              ? fill(step.template ?? '', (path) => render(known.get(path)))
              : parts.map(([, part]) => render(part)).join('');
          if (parts.some(([, part]) => containsTaint(part))) {
            // The clean parts are known, so the result is at least that long.
            assign(
              state,
              step.into,
              new Tainted(
                { type: 'string', required: true, minLength: text.length },
                `string "${step.id}" on model output`,
              ),
            );
          } else {
            assign(state, step.into, text);
          }
          return;
        }
        if (step.args?.length !== 1) {
          throw new PredictedRunError('bad-args', `step "${step.id}" takes one arg`);
        }
        const input = value(step.args[0] ?? null);
        if (input instanceof Tainted) {
          requireTaintedType(step, input, 'string');
          assign(
            state,
            step.into,
            new Tainted(
              transformedStringRule(input.rule, step.op),
              `${step.op} of ${input.origin}`,
            ),
          );
          return;
        }
        const text = asString(step, input);
        assign(
          state,
          step.into,
          { upper: text.toUpperCase(), lower: text.toLowerCase(), trim: text.trim() }[step.op],
        );
        return;
      }

      case 'object': {
        if (step.op === 'set') {
          assign(state, step.into, value(step.value));
          return;
        }
        if (step.op === 'pick') {
          const source = readOrPredictError(state, step.from);
          if (!isRecord(source) && !(source instanceof Tainted)) {
            throw new PredictedRunError('wrong-type', `step "${step.id}" expected an object`);
          }
          const picked: Record<string, unknown> = {};
          for (const field of step.fields)
            picked[field] = readOrPredictError({ source }, `source.${field}`);
          assign(state, step.into, picked);
          return;
        }
        const merged: Record<string, unknown> = {};
        for (const path of step.sources) {
          const source = readOrPredictError(state, path);
          if (source instanceof Tainted) {
            if (source.rule.type !== 'object') {
              // Unknown keys: the merge result as a whole is unknown.
              assign(
                state,
                step.into,
                new Tainted(
                  { type: 'any', required: true },
                  `merge "${step.id}" of ${source.origin}`,
                ),
              );
              return;
            }
            for (const [key, rule] of Object.entries(source.rule.fields)) {
              merged[key] = new Tainted(rule, `${source.origin} → ${key}`);
            }
          } else if (isRecord(source)) {
            Object.assign(merged, source);
          } else {
            throw new PredictedRunError('wrong-type', `step "${step.id}" expected an object`);
          }
        }
        assign(state, step.into, merged);
        return;
      }

      case 'fetch': {
        const params = placeholders(step.path).map((path) => readOrPredictError(state, path));
        if (params.some(containsTaint)) {
          // Can't replay a request whose URL depends on model output.
          assign(
            state,
            step.into,
            new Tainted(
              { type: 'any', required: true },
              `fetch "${step.id}" with a model-derived path`,
            ),
          );
          return;
        }
        const path = fill(step.path, (ref) =>
          encodeURIComponent(displayText(readOrPredictError(state, ref))),
        );
        const response = await this.fetchJson(path);
        if (response.status !== 200) {
          throw new PredictedRunError(
            'fetch-failed',
            `GET ${path} returned ${String(response.status)}`,
          );
        }
        assign(state, step.into, response.body);
        return;
      }

      case 'ai': {
        // Unmirrored: each field is known only by its declared contract. The
        // answer object itself is plain, so taint stays on the fields.
        const answer = (where: string) => {
          const output: Record<string, unknown> = {};
          for (const [field, rule] of Object.entries(step.output)) {
            output[field] = new Tainted(rule, `ai "${step.id}"${where} → ${field}`);
          }
          return output;
        };
        const checkInput = (input: unknown) => {
          if (input instanceof Tainted) requireTaintedType(step, input, 'string');
          else asString(step, input);
        };

        if (step.each === undefined) {
          checkInput(value(step.input));
          assign(state, step.into, answer(''));
          return;
        }
        // One call per row. The rows themselves stay as they were (fetched
        // rows stay clean); only the field each answer lands in is tainted.
        const rows = readOrPredictError(state, step.each.rows);
        if (rows instanceof Tainted) {
          assign(
            state,
            step.each.rows,
            new Tainted({ type: 'any', required: true }, `rows labelled by ai "${step.id}"`),
          );
          return;
        }
        if (!Array.isArray(rows)) {
          throw new PredictedRunError(
            'wrong-type',
            `step "${step.id}": "${step.each.rows}" is not a list`,
          );
        }
        for (let i = 0; i < rows.length; i++) {
          const rowPath = `${step.each.rows}.${String(i)}`;
          const row = readOrPredictError(state, rowPath);
          if (!isRecord(row) && !(row instanceof Tainted)) {
            throw new PredictedRunError('wrong-type', `step "${step.id}" expected an object`);
          }
          checkInput(readOrPredictError(state, `${rowPath}.${step.each.input}`));
          assign(state, `${rowPath}.${step.into}`, answer(` row ${String(i)}`));
        }
        return;
      }

      case 'id': {
        const length = step.prefix.length + step.length;
        const pattern = `^${escapeRegExp(step.prefix)}[${step.alphabet}]{${String(step.length)}}$`;
        assign(
          state,
          step.into,
          new Tainted(
            { type: 'string', required: true, minLength: length, maxLength: length, pattern },
            `id "${step.id}"`,
          ),
        );
        return;
      }
    }
  }
}
