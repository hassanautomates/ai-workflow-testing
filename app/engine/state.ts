import type { Operand } from './schema.ts';

/** Run state: the values a workflow has collected and computed so far. */
export type State = Readonly<Record<string, unknown>>;

/**
 * Why a run ended in an error. Rendered as data-error-code on the error page,
 * so tests can check the cause without depending on message wording.
 */
export type EngineErrorCode =
  | 'missing-value'
  | 'wrong-type'
  | 'bad-args'
  | 'divide-by-zero'
  | 'fetch-failed'
  | 'ai-contract'
  | 'step-loop';

/**
 * A problem caused by the workflow or its data (missing value, wrong type,
 * failed fetch). It ends the run with an error page rather than a 500.
 */
export class EngineError extends Error {
  override name = 'EngineError';
  constructor(
    readonly code: EngineErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads `a.b.0.c`. Missing paths throw, so a typo in a workflow fails loudly. */
export function getPath(state: State, path: string): unknown {
  let current: unknown = state;
  for (const key of path.split('.')) {
    if (Array.isArray(current) && /^\d+$/.test(key) && Number(key) < current.length) {
      current = current[Number(key)];
    } else if (isPlainObject(current) && Object.hasOwn(current, key)) {
      current = current[key];
    } else {
      throw new EngineError('missing-value', `state has no value at "${path}"`);
    }
  }
  return current;
}

export function hasPath(state: State, path: string): boolean {
  try {
    getPath(state, path);
    return true;
  } catch (error) {
    if (error instanceof EngineError) return false;
    throw error;
  }
}

/**
 * Returns a copy of `container` with `path` set. Missing parent objects are
 * created; a numeric segment inside an existing array writes that index.
 */
function setIn(container: unknown, keys: readonly string[], value: unknown): unknown {
  const [head, ...rest] = keys;
  if (head === undefined) return value;
  if (Array.isArray(container) && /^\d+$/.test(head) && Number(head) < container.length) {
    const copy: unknown[] = [...(container as unknown[])];
    copy[Number(head)] = setIn(copy[Number(head)], rest, value);
    return copy;
  }
  const object = isPlainObject(container) ? container : {};
  return { ...object, [head]: setIn(object[head], rest, value) };
}

export function setPath(state: State, path: string, value: unknown): State {
  if (path === '') throw new EngineError('bad-args', 'empty state path');
  return setIn(state, path.split('.'), value) as State;
}

export function resolveOperand(state: State, operand: Operand): unknown {
  return isPlainObject(operand) ? getPath(state, operand.ref) : operand;
}

/** How a value appears on a page and inside templates. */
export function toDisplayString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

const placeholder = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Replaces `{{dot.path}}` placeholders. `encode` lets fetch URL-encode each value. */
export function fillTemplate(
  template: string,
  state: State,
  encode: (text: string) => string = (text) => text,
): string {
  return template.replace(placeholder, (_match, path: string) =>
    encode(toDisplayString(getPath(state, path))),
  );
}

/**
 * Rounds half away from zero. Shifting via the decimal exponent avoids the
 * binary-float trap where 1.005 * 100 is 100.49999.
 */
export function roundTo(value: number, decimals: number): number {
  const magnitude = Math.abs(value);
  const text = String(magnitude);
  const rounded = text.includes('e')
    ? Math.round(magnitude * 10 ** decimals) / 10 ** decimals
    : Number(`${String(Math.round(Number(`${text}e${String(decimals)}`)))}e-${String(decimals)}`);
  // `|| 0` turns -0 into 0 so a rounded negative never displays as "-0".
  return (value < 0 ? -rounded : rounded) || 0;
}
