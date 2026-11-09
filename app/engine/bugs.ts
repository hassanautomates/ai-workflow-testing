import type { BlockHandlers } from './blocks.ts';
import { getPath, hasPath, isPlainObject, setPath } from './state.ts';

// Deliberate defects, switched on with ENGINE_BUG=<name>, to prove the test
// harness catches real bugs. Each one wraps a single block handler; the engine
// itself never knows. Off by default, and an unknown name stops the server.

interface EngineBug {
  /** Which kind of block it breaks. */
  target: string;
  /** What goes wrong, in a sentence. Used verbatim in reports/prove.md. */
  description: string;
  apply: (handlers: BlockHandlers) => BlockHandlers;
}

export const engineBugs = {
  'math-off-by-one': {
    target: 'math (deterministic)',
    description: 'Every math result comes out 1 too high.',
    apply: (handlers) => ({
      ...handlers,
      math: async (step, ctx) => {
        const result = await handlers.math(step, ctx);
        const value = getPath(result.state, step.into) as number;
        return { ...result, state: setPath(result.state, step.into, value + 1) };
      },
    }),
  },
  'wrong-branch': {
    target: 'condition (deterministic, and on model output)',
    description: 'Every condition takes the opposite branch.',
    apply: (handlers) => ({
      ...handlers,
      condition: async (step, ctx) => {
        const result = await handlers.condition(step, ctx);
        return { ...result, goto: result.goto === step.then ? step.else : step.then };
      },
    }),
  },
  'drop-field': {
    target: 'object (deterministic)',
    description: 'object pick silently drops the last field it was asked for.',
    apply: (handlers) => ({
      ...handlers,
      object: (step, ctx) =>
        handlers.object(
          step.op === 'pick' && step.fields.length > 1
            ? { ...step, fields: step.fields.slice(0, -1) }
            : step,
          ctx,
        ),
    }),
  },
  'ai-overwrites-field': {
    target: 'ai (model output leaking into deterministic data)',
    description:
      "The model's first answer field is also written over the input it read, clobbering fetched or entered data.",
    apply: (handlers) => ({
      ...handlers,
      ai: async (step, ctx) => {
        const result = await handlers.ai(step, ctx);
        const firstField = Object.keys(step.output)[0] ?? '';
        let state = result.state;
        if (step.each) {
          const rows = getPath(state, step.each.rows) as unknown[];
          rows.forEach((_row, i) => {
            const row = `${step.each?.rows ?? ''}.${String(i)}`;
            const answer = getPath(state, `${row}.${step.into}`);
            if (isPlainObject(answer)) {
              state = setPath(state, `${row}.${step.each?.input ?? ''}`, answer[firstField]);
            }
          });
        } else if (isPlainObject(step.input) && hasPath(state, step.into)) {
          const answer = getPath(state, step.into);
          if (isPlainObject(answer)) state = setPath(state, step.input.ref, answer[firstField]);
        }
        return { ...result, state };
      },
    }),
  },
  'round-toward-zero': {
    target: 'math rounding (deterministic)',
    description:
      'math rounds by truncating instead of half away from zero, so 4.947525 shows as 4.94, not 4.95.',
    apply: (handlers) => ({
      ...handlers,
      math: async (step, ctx) => {
        if (step.decimals === undefined) return handlers.math(step, ctx);
        const { decimals, ...unrounded } = step;
        const result = await handlers.math(unrounded, ctx);
        const scale = 10 ** decimals;
        const value = getPath(result.state, step.into) as number;
        return {
          ...result,
          state: setPath(result.state, step.into, Math.trunc(value * scale) / scale),
        };
      },
    }),
  },
} satisfies Record<string, EngineBug>;

export type EngineBugName = keyof typeof engineBugs;

export function isEngineBug(name: string): name is EngineBugName {
  return Object.hasOwn(engineBugs, name);
}

/** The handlers with one bug switched in, or unchanged when `name` is empty. */
export function withEngineBug(handlers: BlockHandlers, name: string | undefined): BlockHandlers {
  if (!name) return handlers;
  if (!isEngineBug(name)) {
    throw new Error(
      `unknown ENGINE_BUG "${name}"; expected one of: ${Object.keys(engineBugs).join(', ')}`,
    );
  }
  return engineBugs[name].apply(handlers);
}
