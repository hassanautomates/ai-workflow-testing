import { displayText } from './display.ts';

// Shapes describe what the harness can say about a value it can't predict.
// Model-output shapes come straight from the contract declared on the ai
// block in the workflow JSON; the harness never invents bounds of its own.
// Derived values (a total computed from a model's amount) get shapes worked
// out from their inputs' shapes.

// Bounds are optional; `undefined` means "not constrained".
export type ShapeRule =
  | {
      type: 'string';
      required: boolean;
      minLength?: number | undefined;
      maxLength?: number | undefined;
      allowed?: string[] | undefined;
      pattern?: string | undefined;
    }
  | {
      type: 'number';
      required: boolean;
      min?: number | undefined;
      max?: number | undefined;
      decimals?: number | undefined;
      allowed?: number[] | undefined;
    }
  | { type: 'boolean'; required: boolean }
  /** An object whose fields each have their own shape. Unlisted keys are not allowed. */
  | { type: 'object'; required: boolean; fields: Record<string, ShapeRule> }
  /** A clean value sitting inside a tainted object: must match exactly. */
  | { type: 'exact'; required: boolean; value: unknown }
  /** Nothing known beyond "it is there". */
  | { type: 'any'; required: boolean };

/**
 * A value the mirror cannot know, because it came from model output or a
 * random ID, or was computed from one. It carries what *can* be checked
 * (its shape) and where it came from, for error messages.
 */
export class Tainted {
  constructor(
    readonly rule: ShapeRule,
    readonly origin: string,
  ) {}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Tainted)
  );
}

/** True if the value is tainted or holds a tainted value anywhere inside it. */
export function containsTaint(value: unknown): boolean {
  if (value instanceof Tainted) return true;
  if (Array.isArray(value)) return value.some(containsTaint);
  if (isRecord(value)) return Object.values(value).some(containsTaint);
  return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The shape of a value: its own rule if tainted, else built from its parts. */
export function shapeOf(value: unknown): ShapeRule {
  if (value instanceof Tainted) return value.rule;
  if (isRecord(value) && containsTaint(value)) {
    const fields: Record<string, ShapeRule> = {};
    for (const [key, child] of Object.entries(value)) fields[key] = shapeOf(child);
    return { type: 'object', required: true, fields };
  }
  if (Array.isArray(value) && containsTaint(value)) return { type: 'any', required: true };
  return { type: 'exact', required: true, value };
}

function decimalPlaces(value: number): number {
  const text = String(value);
  return text.includes('e') ? Infinity : (text.split('.')[1]?.length ?? 0);
}

/** Ways a value breaks a rule. Empty means it fits. */
export function valueViolations(value: unknown, rule: ShapeRule, at = 'value'): string[] {
  const problems: string[] = [];
  switch (rule.type) {
    case 'string':
      if (typeof value !== 'string') return [`${at} should be a string`];
      if (rule.minLength !== undefined && value.length < rule.minLength) {
        problems.push(`${at} is shorter than ${String(rule.minLength)}`);
      }
      if (rule.maxLength !== undefined && value.length > rule.maxLength) {
        problems.push(`${at} is longer than ${String(rule.maxLength)}`);
      }
      if (rule.allowed && !rule.allowed.includes(value)) {
        problems.push(`${at} should be one of ${rule.allowed.join(', ')}`);
      }
      if (rule.pattern !== undefined && !new RegExp(rule.pattern).test(value)) {
        problems.push(`${at} should match ${rule.pattern}`);
      }
      return problems;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${at} should be a number`];
      if (rule.min !== undefined && value < rule.min) {
        problems.push(`${at} is below ${String(rule.min)}`);
      }
      if (rule.max !== undefined && value > rule.max) {
        problems.push(`${at} is above ${String(rule.max)}`);
      }
      if (rule.decimals !== undefined && decimalPlaces(value) > rule.decimals) {
        problems.push(`${at} has more than ${String(rule.decimals)} decimals`);
      }
      if (rule.allowed && !rule.allowed.includes(value)) {
        problems.push(`${at} should be one of ${rule.allowed.join(', ')}`);
      }
      return problems;
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${at} should be a boolean`];
    case 'object': {
      if (!isRecord(value)) return [`${at} should be an object`];
      for (const [key, child] of Object.entries(rule.fields)) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          problems.push(...valueViolations(value[key], child, `${at}.${key}`));
        } else if (child.required) {
          problems.push(`${at}.${key} is missing`);
        }
      }
      for (const key of Object.keys(value)) {
        if (!(key in rule.fields)) problems.push(`${at}.${key} is not in the contract`);
      }
      return problems;
    }
    case 'exact':
      return deepEqual(value, rule.value)
        ? []
        : [`${at} should equal ${JSON.stringify(rule.value)}`];
    case 'any':
      return [];
  }
}

/**
 * Ways the text the app displayed breaks a rule. Displayed text is parsed
 * back into a value the way the app renders it: numbers as String(n),
 * booleans as "true"/"false", objects as JSON.
 */
export function displayedViolations(text: string, rule: ShapeRule): string[] {
  if (!rule.required && text === '') return [];
  switch (rule.type) {
    case 'any':
      return [];
    case 'exact':
      return text === displayText(rule.value)
        ? []
        : [`"${text}" should be "${displayText(rule.value)}"`];
    case 'string':
      return valueViolations(text, rule, 'text');
    case 'number': {
      const parsed = text.trim() === '' ? NaN : Number(text);
      return Number.isFinite(parsed)
        ? valueViolations(parsed, rule, 'text')
        : [`"${text}" should be a number`];
    }
    case 'boolean':
      return text === 'true' || text === 'false' ? [] : [`"${text}" should be true or false`];
    case 'object': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return [`"${text}" should be a JSON object`];
      }
      return valueViolations(parsed, rule, 'object');
    }
  }
}
