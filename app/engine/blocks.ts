import { randomInt } from 'node:crypto';
import { contractViolations } from '../ai/contract.ts';
import { simulateModel } from '../ai/simulate.ts';
import type { HeadlessStep } from './schema.ts';
import {
  EngineError,
  type State,
  fillTemplate,
  getPath,
  isPlainObject,
  resolveOperand,
  roundTo,
  setPath,
  toDisplayString,
} from './state.ts';

export interface BlockContext {
  state: State;
  /** GET a path on the mock API and return the parsed JSON body. */
  fetchJson: (path: string) => Promise<unknown>;
}

export interface BlockResult {
  state: State;
  /** Jump to this step instead of the default next one (used by `condition`). */
  goto?: string;
}

type BlockName = HeadlessStep['block'];
type StepOf<B extends BlockName> = Extract<HeadlessStep, { block: B }>;
type Handler<B extends BlockName> = (step: StepOf<B>, ctx: BlockContext) => Promise<BlockResult>;

/**
 * One handler per headless block. The engine only ever reaches blocks through
 * this table, which is the seam for ENGINE_BUG: a faulty variant of a handler
 * can be swapped in at composition time without touching the engine.
 */
export type BlockHandlers = { readonly [B in BlockName]: Handler<B> };

function requireNumber(stepId: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EngineError(
      'wrong-type',
      `step "${stepId}" expected a number, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireString(stepId: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new EngineError(
      'wrong-type',
      `step "${stepId}" expected a string, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireObject(stepId: string, value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new EngineError(
      'wrong-type',
      `step "${stepId}" expected an object, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function onlyArg(step: StepOf<'string'>, state: State): string {
  const arg = step.args?.length === 1 ? step.args[0] : undefined;
  if (arg === undefined) {
    throw new EngineError('bad-args', `step "${step.id}": op ${step.op} takes one arg`);
  }
  return requireString(step.id, resolveOperand(state, arg));
}

const math: Handler<'math'> = (step, { state }) => {
  const [first, ...rest] = step.args.map((arg) =>
    requireNumber(step.id, resolveOperand(state, arg)),
  );
  if (first === undefined) throw new EngineError('bad-args', `step "${step.id}" has no args`);
  const result = rest.reduce((acc, value) => {
    switch (step.op) {
      case 'add':
        return acc + value;
      case 'sub':
        return acc - value;
      case 'mul':
        return acc * value;
      case 'div':
        if (value === 0) {
          throw new EngineError('divide-by-zero', `step "${step.id}" divides by zero`);
        }
        return acc / value;
    }
  }, first);
  const value = step.decimals === undefined ? result : roundTo(result, step.decimals);
  return Promise.resolve({ state: setPath(state, step.into, value) });
};

const string: Handler<'string'> = (step, { state }) => {
  let value: string;
  switch (step.op) {
    case 'template':
      value = fillTemplate(step.template ?? '', state);
      break;
    case 'concat':
      value = (step.args ?? []).map((arg) => toDisplayString(resolveOperand(state, arg))).join('');
      break;
    case 'upper':
      value = onlyArg(step, state).toUpperCase();
      break;
    case 'lower':
      value = onlyArg(step, state).toLowerCase();
      break;
    case 'trim':
      value = onlyArg(step, state).trim();
      break;
  }
  return Promise.resolve({ state: setPath(state, step.into, value) });
};

const object: Handler<'object'> = (step, { state }) => {
  let value: unknown;
  switch (step.op) {
    case 'set':
      value = resolveOperand(state, step.value);
      break;
    case 'pick': {
      const source = requireObject(step.id, getPath(state, step.from));
      value = Object.fromEntries(
        step.fields.map((field) => [field, getPath(source, field)] as const),
      );
      break;
    }
    case 'merge':
      // Later sources win on key clashes, like Object.assign.
      value = Object.assign(
        {},
        ...step.sources.map((source) => requireObject(step.id, getPath(state, source))),
      ) as Record<string, unknown>;
      break;
  }
  return Promise.resolve({ state: setPath(state, step.into, value) });
};

const condition: Handler<'condition'> = (step, { state }) => {
  const left = resolveOperand(state, step.if.left);
  const right = resolveOperand(state, step.if.right);
  let holds: boolean;
  switch (step.if.cmp) {
    case 'eq':
      holds = left === right;
      break;
    case 'ne':
      holds = left !== right;
      break;
    case 'gt':
      holds = requireNumber(step.id, left) > requireNumber(step.id, right);
      break;
    case 'gte':
      holds = requireNumber(step.id, left) >= requireNumber(step.id, right);
      break;
    case 'lt':
      holds = requireNumber(step.id, left) < requireNumber(step.id, right);
      break;
    case 'lte':
      holds = requireNumber(step.id, left) <= requireNumber(step.id, right);
      break;
  }
  return Promise.resolve({ state, goto: holds ? step.then : step.else });
};

const fetchBlock: Handler<'fetch'> = async (step, { state, fetchJson }) => {
  const path = fillTemplate(step.path, state, encodeURIComponent);
  return { state: setPath(state, step.into, await fetchJson(path)) };
};

/** Model output is untrusted: anything outside the declared contract ends the run. */
function aiBlock(seed: string): Handler<'ai'> {
  return (step, { state }) => {
    const input = requireString(step.id, resolveOperand(state, step.input));
    const output = simulateModel({
      seed,
      stepId: step.id,
      prompt: step.prompt,
      input,
      output: step.output,
    });
    const problems = contractViolations(output, step.output);
    if (problems.length > 0) {
      throw new EngineError(
        'ai-contract',
        `step "${step.id}": model output broke its contract: ${problems.join('; ')}`,
      );
    }
    return Promise.resolve({ state: setPath(state, step.into, output) });
  };
}

const idBlock: Handler<'id'> = (step, { state }) => {
  let id = step.prefix;
  for (let i = 0; i < step.length; i++) id += step.alphabet.charAt(randomInt(step.alphabet.length));
  return Promise.resolve({ state: setPath(state, step.into, id) });
};

export interface BlockOptions {
  /** Seeds the simulated model. See AI_SEED. */
  aiSeed: string;
}

export function createBlockHandlers({ aiSeed }: BlockOptions): BlockHandlers {
  return { math, string, object, condition, fetch: fetchBlock, ai: aiBlock(aiSeed), id: idBlock };
}
