import { HarnessError } from './errors.ts';
import type { ShapeRule } from './shape.ts';

// The harness's own view of a workflow, as served by GET /api/workflows. It is
// declared here rather than imported from the app on purpose: if the app's
// format drifts, parsing fails here instead of silently agreeing with the app.

export type Operand = number | string | boolean | null | { ref: string };

interface StepCommon {
  id: string;
  next?: string;
}

export type MathStep = StepCommon & {
  block: 'math';
  op: 'add' | 'sub' | 'mul' | 'div';
  args: Operand[];
  decimals?: number;
  into: string;
};
export type StringStep = StepCommon & {
  block: 'string';
  op: 'concat' | 'upper' | 'lower' | 'trim' | 'template';
  args?: Operand[];
  template?: string;
  into: string;
};
export type ObjectStep = StepCommon & { block: 'object'; into: string } & (
    | { op: 'set'; value: Operand }
    | { op: 'pick'; from: string; fields: string[] }
    | { op: 'merge'; sources: string[] }
  );
export type ConditionStep = StepCommon & {
  block: 'condition';
  if: { left: Operand; cmp: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; right: Operand };
  then: string;
  else: string;
};
export type FetchStep = StepCommon & { block: 'fetch'; path: string; into: string };
/** Unmirrored: the mirror only knows its output contract, one rule per field. */
export type AiStep = StepCommon & {
  block: 'ai';
  output: Record<string, ShapeRule>;
  into: string;
} & (
    | { input: Operand; each?: undefined }
    /** One model call per row; each answer lands at `into` inside its row. */
    | { input?: undefined; each: { rows: string; input: string } }
  );
/** Unmirrored: a random ID, known only by its format. */
export type IdStep = StepCommon & {
  block: 'id';
  prefix: string;
  length: number;
  alphabet: string;
  into: string;
};

export interface FormField {
  name: string;
  type: 'text' | 'textarea' | 'number';
  required: boolean;
}
export type FormStep = StepCommon & { block: 'form'; fields: FormField[] };
export type DetailsStep = StepCommon & {
  block: 'details';
  /** `optional`: the value may be missing; the app then marks the element data-absent. */
  fields: { path: string; optional: boolean }[];
};
export type TableStep = StepCommon & { block: 'table'; rows: string; columns: { key: string }[] };

export type HeadlessStep =
  MathStep | StringStep | ObjectStep | ConditionStep | FetchStep | AiStep | IdStep;
export type UiStep = FormStep | DetailsStep | TableStep;
export type Step = HeadlessStep | UiStep;

export interface Case {
  name: string;
  /** Form step id → field name → the text to type. */
  inputs: Record<string, Record<string, string>>;
}

export interface Workflow {
  id: string;
  name: string;
  published: boolean;
  steps: Step[];
  cases: Case[];
}

export function isUiStep(step: Step): step is UiStep {
  return step.block === 'form' || step.block === 'details' || step.block === 'table';
}

// --- parsing -----------------------------------------------------------------
// Only checks what the mirror and driver rely on. Labels, titles and the like
// are ignored: they never affect expected values.

type Json = Record<string, unknown>;

function record(value: unknown, where: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HarnessError(`${where}: expected an object`);
  }
  return value as Json;
}

function text(source: Json, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== 'string') throw new HarnessError(`${where}.${key}: expected a string`);
  return value;
}

function optionalText(source: Json, key: string, where: string): string | undefined {
  return source[key] === undefined ? undefined : text(source, key, where);
}

function list(source: Json, key: string, where: string): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) throw new HarnessError(`${where}.${key}: expected an array`);
  return value;
}

function oneOf<T extends string>(
  source: Json,
  key: string,
  allowed: readonly T[],
  where: string,
): T {
  const value = text(source, key, where);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new HarnessError(`${where}.${key}: "${value}" is not one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function operand(value: unknown, where: string): Operand {
  if (value === null || ['number', 'string', 'boolean'].includes(typeof value)) {
    return value as Operand;
  }
  const ref = record(value, where);
  if (Object.keys(ref).length !== 1) throw new HarnessError(`${where}: expected { ref }`);
  return { ref: text(ref, 'ref', where) };
}

function operands(source: Json, key: string, where: string): Operand[] {
  return list(source, key, where).map((item, i) => operand(item, `${where}.${key}[${String(i)}]`));
}

function strings(source: Json, key: string, where: string): string[] {
  return list(source, key, where).map((item, i) => {
    if (typeof item !== 'string')
      throw new HarnessError(`${where}.${key}[${String(i)}]: expected a string`);
    return item;
  });
}

function optionalNumber(source: Json, key: string, where: string): number | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new HarnessError(`${where}.${key}: expected a number`);
  return value;
}

function numbers(source: Json, key: string, where: string): number[] {
  return list(source, key, where).map((item, i) => {
    if (typeof item !== 'number') {
      throw new HarnessError(`${where}.${key}[${String(i)}]: expected a number`);
    }
    return item;
  });
}

/**
 * One field of an ai block's output contract, read as a shape rule. Only
 * bounds actually declared in the JSON end up in the rule.
 */
function parseOutputRule(raw: unknown, where: string): ShapeRule {
  const source = record(raw, where);
  // The app's schema defaults `required` to true.
  const required = source.required !== false;
  switch (oneOf(source, 'type', ['string', 'number', 'boolean'], where)) {
    case 'string':
      return {
        type: 'string',
        required,
        minLength: optionalNumber(source, 'minLength', where),
        maxLength: optionalNumber(source, 'maxLength', where),
        allowed: source.allowed === undefined ? undefined : strings(source, 'allowed', where),
      };
    case 'number':
      return {
        type: 'number',
        required,
        min: optionalNumber(source, 'min', where),
        max: optionalNumber(source, 'max', where),
        decimals: optionalNumber(source, 'decimals', where),
        allowed: source.allowed === undefined ? undefined : numbers(source, 'allowed', where),
      };
    case 'boolean':
      return { type: 'boolean', required };
  }
}

function parseStep(raw: unknown, where: string): Step {
  const source = record(raw, where);
  const id = text(source, 'id', where);
  const next = optionalText(source, 'next', where);
  const common: StepCommon = next === undefined ? { id } : { id, next };
  const at = `${where}(${id})`;
  const block = text(source, 'block', where);

  switch (block) {
    case 'math': {
      const decimals = source.decimals;
      if (decimals !== undefined && (typeof decimals !== 'number' || !Number.isInteger(decimals))) {
        throw new HarnessError(`${at}.decimals: expected an integer`);
      }
      return {
        ...common,
        block,
        op: oneOf(source, 'op', ['add', 'sub', 'mul', 'div'], at),
        args: operands(source, 'args', at),
        ...(decimals === undefined ? {} : { decimals }),
        into: text(source, 'into', at),
      };
    }
    case 'string': {
      const template = optionalText(source, 'template', at);
      return {
        ...common,
        block,
        op: oneOf(source, 'op', ['concat', 'upper', 'lower', 'trim', 'template'], at),
        ...(source.args === undefined ? {} : { args: operands(source, 'args', at) }),
        ...(template === undefined ? {} : { template }),
        into: text(source, 'into', at),
      };
    }
    case 'object': {
      const into = text(source, 'into', at);
      const op = oneOf(source, 'op', ['set', 'pick', 'merge'], at);
      if (op === 'set')
        return { ...common, block, into, op, value: operand(source.value, `${at}.value`) };
      if (op === 'pick') {
        return {
          ...common,
          block,
          into,
          op,
          from: text(source, 'from', at),
          fields: strings(source, 'fields', at),
        };
      }
      return { ...common, block, into, op, sources: strings(source, 'sources', at) };
    }
    case 'condition': {
      const test = record(source.if, `${at}.if`);
      return {
        ...common,
        block,
        if: {
          left: operand(test.left, `${at}.if.left`),
          cmp: oneOf(test, 'cmp', ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'], `${at}.if`),
          right: operand(test.right, `${at}.if.right`),
        },
        then: text(source, 'then', at),
        else: text(source, 'else', at),
      };
    }
    case 'fetch':
      return { ...common, block, path: text(source, 'path', at), into: text(source, 'into', at) };
    case 'ai': {
      const output: Record<string, ShapeRule> = {};
      for (const [field, rule] of Object.entries(record(source.output, `${at}.output`))) {
        output[field] = parseOutputRule(rule, `${at}.output.${field}`);
      }
      const into = text(source, 'into', at);
      if (source.each !== undefined) {
        const each = record(source.each, `${at}.each`);
        return {
          ...common,
          block,
          each: {
            rows: text(each, 'rows', `${at}.each`),
            input: text(each, 'input', `${at}.each`),
          },
          output,
          into,
        };
      }
      return { ...common, block, input: operand(source.input, `${at}.input`), output, into };
    }
    case 'id': {
      const length = source.length;
      if (typeof length !== 'number' || !Number.isInteger(length) || length < 1) {
        throw new HarnessError(`${at}.length: expected a positive integer`);
      }
      const alphabet = text(source, 'alphabet', at);
      if (!/^[A-Z0-9]+$/.test(alphabet)) {
        throw new HarnessError(`${at}.alphabet: expected only A-Z and 0-9`);
      }
      return {
        ...common,
        block,
        prefix: text(source, 'prefix', at),
        length,
        alphabet,
        into: text(source, 'into', at),
      };
    }
    case 'form':
      return {
        ...common,
        block,
        fields: list(source, 'fields', at).map((rawField, i) => {
          const field = record(rawField, `${at}.fields[${String(i)}]`);
          const where = `${at}.fields[${String(i)}]`;
          return {
            name: text(field, 'name', where),
            type: oneOf(field, 'type', ['text', 'textarea', 'number'], where),
            // The app's schema defaults `required` to true.
            required: field.required !== false,
          };
        }),
      };
    case 'details':
      return {
        ...common,
        block,
        fields: list(source, 'fields', at).map((rawField, i) => {
          const field = record(rawField, `${at}.fields[${String(i)}]`);
          return {
            path: text(field, 'path', `${at}.fields[${String(i)}]`),
            optional: field.optional === true,
          };
        }),
      };
    case 'table':
      return {
        ...common,
        block,
        rows: text(source, 'rows', at),
        columns: list(source, 'columns', at).map((rawColumn, i) => ({
          key: text(
            record(rawColumn, `${at}.columns[${String(i)}]`),
            'key',
            `${at}.columns[${String(i)}]`,
          ),
        })),
      };
    default:
      // A block the harness can't mirror must fail loudly, never be skipped.
      throw new HarnessError(`${at}: unsupported block "${block}"`);
  }
}

function parseCase(raw: unknown, where: string): Case {
  const source = record(raw, where);
  const name = text(source, 'name', where);
  const inputs: Case['inputs'] = {};
  for (const [stepId, rawValues] of Object.entries(record(source.inputs, `${where}.inputs`))) {
    const values = record(rawValues, `${where}.inputs.${stepId}`);
    inputs[stepId] = {};
    for (const field of Object.keys(values)) {
      inputs[stepId][field] = text(values, field, `${where}.inputs.${stepId}`);
    }
  }
  return { name, inputs };
}

export function parseWorkflow(raw: unknown, where = 'workflow'): Workflow {
  const source = record(raw, where);
  const id = text(source, 'id', where);
  const at = `${where}(${id})`;
  if (typeof source.published !== 'boolean')
    throw new HarnessError(`${at}.published: expected a boolean`);
  return {
    id,
    name: text(source, 'name', at),
    published: source.published,
    steps: list(source, 'steps', at).map((step, i) => parseStep(step, `${at}.steps[${String(i)}]`)),
    cases: list(source, 'cases', at).map((item, i) => parseCase(item, `${at}.cases[${String(i)}]`)),
  };
}
