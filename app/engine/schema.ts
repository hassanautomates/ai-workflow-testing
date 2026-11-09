import { z } from 'zod';

// Workflow definitions are JSON, so they are validated at load time. A bad
// workflow should fail the server start, not a user's run halfway through.

/** A literal value, or `{ "ref": "dot.path" }` to read from run state. */
const operand = z.union([
  z.number(),
  z.string(),
  z.boolean(),
  z.null(),
  z.strictObject({ ref: z.string().min(1) }),
]);
export type Operand = z.infer<typeof operand>;

const stepId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'step ids are lowercase kebab-case');
const statePath = z.string().regex(/^[A-Za-z_][\w]*(\.[\w]+)*$/, 'dot path like a.b.0.c');

/** Fields every step has. `next` overrides the default "following step" order. */
const stepBase = { id: stepId, next: stepId.optional() };

const mathStep = z.strictObject({
  ...stepBase,
  block: z.literal('math'),
  op: z.enum(['add', 'sub', 'mul', 'div']),
  args: z.array(operand).min(2),
  /** Round the result to this many decimal places, half away from zero. */
  decimals: z.number().int().min(0).max(10).optional(),
  into: statePath,
});

const stringStep = z.strictObject({
  ...stepBase,
  block: z.literal('string'),
  op: z.enum(['concat', 'upper', 'lower', 'trim', 'template']),
  /** Inputs for concat/upper/lower/trim. upper/lower/trim take exactly one. */
  args: z.array(operand).min(1).optional(),
  /** For op "template": `{{dot.path}}` placeholders are filled from state. */
  template: z.string().optional(),
  into: statePath,
});

const objectStep = z.discriminatedUnion('op', [
  z.strictObject({
    ...stepBase,
    block: z.literal('object'),
    op: z.literal('set'),
    value: operand,
    into: statePath,
  }),
  z.strictObject({
    ...stepBase,
    block: z.literal('object'),
    op: z.literal('pick'),
    from: statePath,
    fields: z.array(z.string().min(1)).min(1),
    into: statePath,
  }),
  z.strictObject({
    ...stepBase,
    block: z.literal('object'),
    op: z.literal('merge'),
    sources: z.array(statePath).min(2),
    into: statePath,
  }),
]);

const conditionStep = z.strictObject({
  ...stepBase,
  block: z.literal('condition'),
  if: z.strictObject({
    left: operand,
    cmp: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']),
    right: operand,
  }),
  then: stepId,
  else: stepId,
});

const fetchStep = z.strictObject({
  ...stepBase,
  block: z.literal('fetch'),
  /** Path on the app's own mock API. `{{dot.path}}` placeholders are filled from state. */
  path: z.string().startsWith('/api/'),
  into: statePath,
});

/**
 * One field of a model's output contract. The simulated model always stays
 * inside it, the engine rejects output that doesn't, and the harness reads
 * these same rules to check what it can't predict exactly.
 */
const required = z.boolean().default(true);
const outputRule = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('string'),
    required,
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(1).optional(),
    allowed: z.array(z.string()).min(1).optional(),
  }),
  z.strictObject({
    type: z.literal('number'),
    required,
    min: z.number().optional(),
    max: z.number().optional(),
    /** At most this many decimal places. */
    decimals: z.number().int().min(0).max(10).optional(),
    allowed: z.array(z.number()).min(1).optional(),
  }),
  z.strictObject({ type: z.literal('boolean'), required }),
]);
export type OutputRule = z.infer<typeof outputRule>;

const aiStep = z.strictObject({
  ...stepBase,
  block: z.literal('ai'),
  /** What the model is asked to do. Documentation, and part of the simulation seed. */
  prompt: z.string().min(1),
  /** The text the model reads. Give this or `each`, not both. */
  input: operand.optional(),
  /**
   * Call the model once per row of a list instead: `input` names the row
   * field it reads, and `into` is where each answer goes inside that row.
   */
  each: z.strictObject({ rows: statePath, input: statePath }).optional(),
  /** Field name → rule. The model returns an object with these fields. */
  output: z.record(z.string().regex(/^[A-Za-z_]\w*$/), outputRule),
  into: statePath,
});

const idStep = z.strictObject({
  ...stepBase,
  block: z.literal('id'),
  prefix: z
    .string()
    .regex(/^[A-Z0-9-]*$/)
    .default(''),
  /** Random characters after the prefix. */
  length: z.number().int().min(4).max(32),
  alphabet: z
    .string()
    .regex(/^[A-Z0-9]{2,}$/)
    .default('23456789ABCDEFGHJKMNPQRSTVWXYZ'),
  into: statePath,
});

const formField = z.strictObject({
  name: statePath,
  label: z.string().min(1),
  /** textarea is multi-line text; it is stored exactly like text. */
  type: z.enum(['text', 'textarea', 'number']),
  required: z.boolean().default(true),
});

const formStep = z.strictObject({
  ...stepBase,
  block: z.literal('form'),
  title: z.string().min(1),
  fields: z.array(formField).min(1),
  submitLabel: z.string().default('Continue'),
});

const detailsStep = z.strictObject({
  ...stepBase,
  block: z.literal('details'),
  title: z.string().min(1),
  fields: z
    .array(
      z.strictObject({
        label: z.string().min(1),
        path: statePath,
        /** May be missing (an optional model field); shown as an empty, marked value. */
        optional: z.boolean().default(false),
      }),
    )
    .min(1),
});

const tableStep = z.strictObject({
  ...stepBase,
  block: z.literal('table'),
  title: z.string().min(1),
  /** State path to an array of objects. */
  rows: statePath,
  columns: z.array(z.strictObject({ label: z.string().min(1), key: z.string().min(1) })).min(1),
});

const uiBlocks = new Set<string>(['form', 'details', 'table']);

export const headlessStepSchema = z.union([
  mathStep,
  stringStep,
  objectStep,
  conditionStep,
  fetchStep,
  aiStep,
  idStep,
]);
export const uiStepSchema = z.discriminatedUnion('block', [formStep, detailsStep, tableStep]);
const stepSchema = z.union([headlessStepSchema, uiStepSchema]);

/**
 * A named set of form inputs that drives one run end to end, keyed by form
 * step id, then field name. Tests run once per case. The engine never reads
 * these; they live in the workflow so a new workflow ships with its own cases.
 */
const caseSchema = z.strictObject({
  name: z.string().min(1),
  inputs: z.record(stepId, z.record(z.string(), z.string())),
});

export const workflowSchema = z
  .strictObject({
    id: stepId,
    name: z.string().min(1),
    published: z.boolean(),
    steps: z.array(stepSchema).min(1),
    cases: z.array(caseSchema).min(1),
  })
  .superRefine((workflow, ctx) => {
    const caseNames = new Set<string>();
    for (const testCase of workflow.cases) {
      if (caseNames.has(testCase.name)) {
        ctx.addIssue({ code: 'custom', message: `duplicate case name "${testCase.name}"` });
      }
      caseNames.add(testCase.name);
      for (const [stepKey, values] of Object.entries(testCase.inputs)) {
        const form = workflow.steps.find((step) => step.id === stepKey);
        if (form?.block !== 'form') {
          ctx.addIssue({
            code: 'custom',
            message: `case "${testCase.name}" has inputs for "${stepKey}", which is not a form step`,
          });
          continue;
        }
        for (const name of Object.keys(values)) {
          if (!form.fields.some((field) => field.name === name)) {
            ctx.addIssue({
              code: 'custom',
              message: `case "${testCase.name}" sets unknown field "${name}" on "${stepKey}"`,
            });
          }
        }
      }
    }
    const ids = new Set<string>();
    for (const step of workflow.steps) {
      if (ids.has(step.id))
        ctx.addIssue({ code: 'custom', message: `duplicate step id "${step.id}"` });
      ids.add(step.id);
    }
    for (const step of workflow.steps) {
      const targets = [step.next, ...(step.block === 'condition' ? [step.then, step.else] : [])];
      for (const target of targets) {
        if (target !== undefined && !ids.has(target)) {
          ctx.addIssue({
            code: 'custom',
            message: `step "${step.id}" points at unknown step "${target}"`,
          });
        }
      }
      if (step.block === 'string') {
        const needsTemplate = step.op === 'template';
        if (needsTemplate !== (step.template !== undefined)) {
          ctx.addIssue({
            code: 'custom',
            message: `step "${step.id}": "template" is required for op template and only for it`,
          });
        }
        if (!needsTemplate && step.args === undefined) {
          ctx.addIssue({ code: 'custom', message: `step "${step.id}": op ${step.op} needs args` });
        }
      }
      if (step.block === 'ai') {
        if ((step.input === undefined) === (step.each === undefined)) {
          ctx.addIssue({
            code: 'custom',
            message: `ai step "${step.id}" needs exactly one of "input" or "each"`,
          });
        }
        const rules = Object.entries(step.output);
        if (!rules.some(([, rule]) => rule.required)) {
          ctx.addIssue({ code: 'custom', message: `ai step "${step.id}" needs a required field` });
        }
        for (const [field, rule] of rules) {
          const bad =
            (rule.type === 'number' &&
              rule.min !== undefined &&
              rule.max !== undefined &&
              rule.min > rule.max) ||
            (rule.type === 'string' &&
              rule.minLength !== undefined &&
              rule.maxLength !== undefined &&
              rule.minLength > rule.maxLength);
          if (bad) {
            ctx.addIssue({
              code: 'custom',
              message: `ai step "${step.id}": output "${field}" has bounds no value can meet`,
            });
          }
        }
      }
    }
    if (!workflow.steps.some((step) => uiBlocks.has(step.block))) {
      ctx.addIssue({ code: 'custom', message: 'a workflow needs at least one UI step' });
    }
  });

export type Workflow = z.infer<typeof workflowSchema>;
export type Step = Workflow['steps'][number];
export type HeadlessStep = z.infer<typeof headlessStepSchema>;
export type UiStep = z.infer<typeof uiStepSchema>;
export type FormStep = z.infer<typeof formStep>;
export type AiStep = z.infer<typeof aiStep>;
export type IdStep = z.infer<typeof idStep>;

export function isUiStep(step: Step): step is UiStep {
  return uiBlocks.has(step.block);
}
