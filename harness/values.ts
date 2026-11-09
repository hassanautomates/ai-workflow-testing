// Value semantics the mirror needs to agree with the app on: dot paths,
// how values display, templates and rounding. Written independently of the
// engine on purpose; if the two disagree, a test fails and someone looks.

export type MirrorState = Record<string, unknown>;

export type Lookup = { found: true; value: unknown } | { found: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Follows `a.b.0.c`. Array segments must be whole indices within bounds. */
export function lookup(state: MirrorState, path: string): Lookup {
  let node: unknown = state;
  for (const segment of path.split('.')) {
    if (Array.isArray(node)) {
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

/**
 * Writes a deep copy of `value` at `path`, creating parent objects as needed.
 * Copying on write means no two paths ever share an object, so a later write
 * can't leak into an earlier value.
 */
export function assign(state: MirrorState, path: string, value: unknown): void {
  const segments = path.split('.');
  const last = segments.pop();
  if (last === undefined) return;
  let node = state;
  for (const segment of segments) {
    const child = node[segment];
    if (!isRecord(child)) node[segment] = {};
    node = node[segment] as MirrorState;
  }
  node[last] = structuredClone(value);
}

/** The text the app should render for a value. */
export function displayText(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
      return String(value);
    case 'undefined':
      return '';
    default:
      return value === null ? '' : JSON.stringify(value);
  }
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
