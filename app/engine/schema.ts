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

const formField = z.strictObject({
  name: statePath,
  label: z.string().min(1),
  type: z.enum(['text', 'number']),
  required: z.boolean().default(true),
  /** A valid example input. Tests use it to fill the form. */
  sample: z.string(),
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
  fields: z.array(z.strictObject({ label: z.string().min(1), path: statePath })).min(1),
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
]);
export const uiStepSchema = z.discriminatedUnion('block', [formStep, detailsStep, tableStep]);
const stepSchema = z.union([headlessStepSchema, uiStepSchema]);

export const workflowSchema = z
  .strictObject({
    id: stepId,
    name: z.string().min(1),
    published: z.boolean(),
    steps: z.array(stepSchema).min(1),
  })
  .superRefine((workflow, ctx) => {
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

export function isUiStep(step: Step): step is UiStep {
  return uiBlocks.has(step.block);
}
