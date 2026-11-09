import type { OutputRule } from '../engine/schema.ts';

function decimalPlaces(value: number): number {
  const text = String(value);
  if (text.includes('e')) return Infinity;
  return text.split('.')[1]?.length ?? 0;
}

/** Ways `value` breaks `rule`. Empty means it fits. */
export function ruleViolations(field: string, rule: OutputRule, value: unknown): string[] {
  const problems: string[] = [];
  switch (rule.type) {
    case 'string':
      if (typeof value !== 'string') return [`${field} is not a string`];
      if (rule.minLength !== undefined && value.length < rule.minLength) {
        problems.push(`${field} is shorter than ${String(rule.minLength)}`);
      }
      if (rule.maxLength !== undefined && value.length > rule.maxLength) {
        problems.push(`${field} is longer than ${String(rule.maxLength)}`);
      }
      if (rule.allowed && !rule.allowed.includes(value)) problems.push(`${field} is not allowed`);
      return problems;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${field} is not a number`];
      if (rule.min !== undefined && value < rule.min) problems.push(`${field} is below min`);
      if (rule.max !== undefined && value > rule.max) problems.push(`${field} is above max`);
      if (rule.decimals !== undefined && decimalPlaces(value) > rule.decimals) {
        problems.push(`${field} has too many decimals`);
      }
      if (rule.allowed && !rule.allowed.includes(value)) problems.push(`${field} is not allowed`);
      return problems;
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${field} is not a boolean`];
  }
}

/** Checks a model response against its declared contract, field by field. */
export function contractViolations(
  output: Readonly<Record<string, unknown>>,
  rules: Readonly<Record<string, OutputRule>>,
): string[] {
  const problems: string[] = [];
  for (const [field, rule] of Object.entries(rules)) {
    if (!Object.hasOwn(output, field)) {
      if (rule.required) problems.push(`${field} is missing`);
      continue;
    }
    problems.push(...ruleViolations(field, rule, output[field]));
  }
  for (const field of Object.keys(output)) {
    if (!Object.hasOwn(rules, field)) problems.push(`${field} is not in the contract`);
  }
  return problems;
}
