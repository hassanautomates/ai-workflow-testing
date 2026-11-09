import { Tainted, isRecord } from './shape.ts';

// Value semantics the mirror needs to agree with the app on: dot paths,
// templates and rounding. Written independently of the engine on purpose; if
// the two disagree, a test fails and someone looks.

export type MirrorState = Record<string, unknown>;

export type Lookup = { found: true; value: unknown } | { found: false };

/**
 * Follows `a.b.0.c`. Array segments must be whole indices within bounds.
 * Reading inside a tainted value gives a tainted value: if the parent came
 * from the model, so does every part of it.
 */
export function lookup(state: MirrorState, path: string): Lookup {
  let node: unknown = state;
  let walked = '';
  for (const segment of path.split('.')) {
    walked = walked ? `${walked}.${segment}` : segment;
    if (node instanceof Tainted) {
      const { rule } = node;
      const child = rule.type === 'object' ? rule.fields[segment] : undefined;
      node = new Tainted(child ?? { type: 'any', required: true }, `${node.origin} → ${walked}`);
    } else if (Array.isArray(node)) {
      const index = Number(segment);
      if (!/^\d+$/.test(segment) || index >= node.length) return { found: false };
      node = node[index];
    } else if (isRecord(node) && Object.prototype.hasOwnProperty.call(node, segment)) {
      node = node[segment];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: node };
}

/** Deep copy that keeps Tainted markers (they are immutable, so sharing them is safe). */
export function copyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyValue(child)]));
  }
  return value;
}

/**
 * Writes a deep copy of `value` at `path`, creating parent objects as needed;
 * a numeric segment inside an existing array writes that index. Copying on
 * write means no two paths ever share an object, so a later write can't leak
 * into an earlier value.
 */
export function assign(state: MirrorState, path: string, value: unknown): void {
  const segments = path.split('.');
  const last = segments.pop();
  if (last === undefined) return;
  let node: unknown = state;
  for (const segment of segments) {
    if (Array.isArray(node) && /^\d+$/.test(segment) && Number(segment) < node.length) {
      const index = Number(segment);
      if (!isRecord(node[index]) && !Array.isArray(node[index])) node[index] = {};
      node = node[index];
    } else {
      const record = node as Record<string, unknown>;
      const child = record[segment];
      if (!isRecord(child) && !Array.isArray(child)) record[segment] = {};
      node = record[segment];
    }
  }
  if (Array.isArray(node) && /^\d+$/.test(last) && Number(last) < node.length) {
    node[Number(last)] = copyValue(value);
  } else {
    (node as Record<string, unknown>)[last] = copyValue(value);
  }
}

/** Every `{{ path }}` placeholder in a template, in order of appearance. */
export function placeholders(template: string): string[] {
  return [...template.matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g)].map((match) => match[1] ?? '');
}

/** Replaces each `{{ path }}` placeholder with `valueFor(path)`. */
export function fill(template: string, valueFor: (path: string) => string): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_whole, path: string) =>
    valueFor(path),
  );
}

/**
 * Half away from zero. Scaling first and trimming to 12 significant digits
 * cleans up binary float noise (1.005 * 100 = 100.49999999999999) before
 * rounding, without going through strings of the original value.
 */
export function roundHalfAwayFromZero(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  const scaled = Number((Math.abs(value) * scale).toPrecision(12));
  const result = (Math.sign(value) * Math.round(scaled)) / scale;
  return result === 0 ? 0 : result;
}
