import { describe, expect, it } from 'vitest';
import { createBlockHandlers } from '../../../app/engine/blocks.ts';
import { type Run, createEngine } from '../../../app/engine/engine.ts';
import { type Workflow, workflowSchema } from '../../../app/engine/schema.ts';
import { fetchFromMockApi } from '../../../app/mock-api/index.ts';
import { loadWorkflows } from '../../../app/workflows/load.ts';

const engine = createEngine({
  handlers: createBlockHandlers({ aiSeed: 'unit-test' }),
  fetchJson: fetchFromMockApi,
});
const workflows = loadWorkflows();

function workflow(id: string): Workflow {
  const found = workflows.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no workflow ${id}`);
  return found;
}

/** Submits each step in turn and returns the final run. */
async function drive(wf: Workflow, inputs: Record<string, Record<string, string>>): Promise<Run> {
  let run = await engine.start(wf, 'test-run');
  while (run.status === 'in-progress' && run.currentStepId !== null) {
    const outcome = await engine.submit(
      wf,
      run,
      run.currentStepId,
      inputs[run.currentStepId] ?? {},
    );
    if (outcome.kind !== 'advanced') throw new Error(`step ${run.currentStepId}: ${outcome.kind}`);
    run = outcome.run;
  }
  return run;
}

describe('order-total', () => {
  it('stops at the form first', async () => {
    const run = await engine.start(workflow('order-total'), 'r');
    expect(run).toMatchObject({ status: 'in-progress', currentStepId: 'order', state: {} });
  });

  it('computes the total without a discount under 100', async () => {
    const run = await drive(workflow('order-total'), {
      order: { quantity: '3', unitPrice: '19.99' },
    });
    expect(run.status).toBe('complete');
    expect(run.state).toMatchObject({ subtotal: 59.97, discount: 0, tax: 4.95, total: 64.92 });
    expect(run.state.summary).toBe('3 × 19.99, total 64.92');
  });

  it('takes the discount branch at 100 or more', async () => {
    const run = await drive(workflow('order-total'), {
      order: { quantity: '6', unitPrice: '19.99' },
    });
    expect(run.state).toMatchObject({
      subtotal: 119.94,
      discount: 11.99,
      tax: 8.91,
      total: 116.86,
    });
  });

  it('rejects invalid form input without changing the run', async () => {
    const wf = workflow('order-total');
    const run = await engine.start(wf, 'r');
    const outcome = await engine.submit(wf, run, 'order', { quantity: 'three', unitPrice: '' });
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.errors).toEqual({
      quantity: 'Quantity must be a number',
      unitPrice: 'Unit price is required',
    });
    expect(outcome.run).toBe(run);
  });

  it('treats a submit for a step not on screen as stale', async () => {
    const wf = workflow('order-total');
    const run = await engine.start(wf, 'r');
    const outcome = await engine.submit(wf, run, 'receipt', {});
    expect(outcome).toEqual({ kind: 'stale', run });
  });
});

describe('customer-lookup', () => {
  it('fetches and reshapes the customer, then shows the orders table', async () => {
    const wf = workflow('customer-lookup');
    let run = await engine.start(wf, 'r');
    const outcome = await engine.submit(wf, run, 'lookup', { customerId: 'C-1001' });
    if (outcome.kind !== 'advanced') throw new Error(outcome.kind);
    run = outcome.run;
    expect(run.currentStepId).toBe('profile');
    expect(run.state).toMatchObject({
      fullName: 'Mira Okafor',
      email: 'mira.okafor@example.com',
      location: 'Lisbon, PT',
      account: { tier: 'gold', since: '2019-04-12' },
    });
  });

  it('ends the run with an error for an unknown customer', async () => {
    const run = await drive(workflow('customer-lookup'), { lookup: { customerId: 'C-9999' } });
    expect(run).toMatchObject({ status: 'error', currentStepId: null, errorCode: 'fetch-failed' });
    expect(run.error).toContain('404');
  });

  it('counts screens: 1 for the first, +1 each time the run moves on', async () => {
    const wf = workflow('customer-lookup');
    const first = await engine.start(wf, 'r');
    expect(first.screenSeq).toBe(1);
    const second = await engine.submit(wf, first, 'lookup', { customerId: 'C-1002' });
    expect(second.run.screenSeq).toBe(2);
    // A rejected submit stays on the same screen.
    const invalid = await engine.submit(wf, first, 'lookup', { customerId: '' });
    expect(invalid).toMatchObject({ kind: 'invalid', run: { screenSeq: 1 } });
  });

  it('handles a customer with no orders', async () => {
    const run = await drive(workflow('customer-lookup'), { lookup: { customerId: 'C-1003' } });
    expect(run.status).toBe('complete');
  });
});

describe('blocks not used by the shipped workflows', () => {
  const custom = workflowSchema.parse({
    id: 'blocks',
    name: 'Block coverage',
    published: false,
    steps: [
      {
        id: 'in',
        block: 'form',
        title: 'In',
        fields: [{ name: 'raw', label: 'Raw', type: 'text' }],
      },
      { id: 'trimmed', block: 'string', op: 'trim', args: [{ ref: 'raw' }], into: 'trimmed' },
      { id: 'upper', block: 'string', op: 'upper', args: [{ ref: 'trimmed' }], into: 'shout' },
      { id: 'a', block: 'object', op: 'set', value: { ref: 'shout' }, into: 'left.word' },
      { id: 'b', block: 'object', op: 'set', value: 1, into: 'right.count' },
      { id: 'merged', block: 'object', op: 'merge', sources: ['left', 'right'], into: 'both' },
      {
        id: 'half',
        block: 'math',
        op: 'div',
        args: [{ ref: 'both.count' }, 3],
        decimals: 3,
        into: 'third',
      },
      {
        id: 'is-hi',
        block: 'condition',
        if: { left: { ref: 'both.word' }, cmp: 'eq', right: 'HI' },
        then: 'yes',
        else: 'no',
      },
      { id: 'no', block: 'object', op: 'set', value: 'no', into: 'answer', next: 'out' },
      { id: 'yes', block: 'object', op: 'set', value: 'yes', into: 'answer' },
      { id: 'out', block: 'details', title: 'Out', fields: [{ label: 'Answer', path: 'answer' }] },
    ],
    cases: [{ name: 'padded', inputs: { in: { raw: ' Hi ' } } }],
  });

  it('runs trim, upper, set, merge, div and an eq condition', async () => {
    const run = await drive(custom, { in: { raw: ' Hi ' } });
    expect(run.state).toMatchObject({
      trimmed: 'Hi',
      shout: 'HI',
      both: { word: 'HI', count: 1 },
      third: 0.333,
      answer: 'yes',
    });
  });

  it('fails the run on division by zero', async () => {
    const zero = workflowSchema.parse({
      ...custom,
      steps: custom.steps.map((step) => (step.id === 'half' ? { ...step, args: [1, 0] } : step)),
    });
    const run = await drive(zero, { in: { raw: 'x' } });
    expect(run).toMatchObject({ status: 'error', error: 'step "half" divides by zero' });
  });
});

describe('workflow validation', () => {
  it('loads the shipped workflows sorted by id', () => {
    expect(workflows.map((wf) => wf.id)).toEqual([
      'customer-lookup',
      'invoice-extraction',
      'invoice-total',
      'order-categories',
      'order-confirmation',
      'order-total',
      'refund-request',
      'ticket-triage',
    ]);
  });

  it('rejects unknown step targets and duplicate ids', () => {
    const result = workflowSchema.safeParse({
      id: 'bad',
      name: 'Bad',
      published: true,
      steps: [
        {
          id: 'x',
          block: 'details',
          title: 'X',
          fields: [{ label: 'A', path: 'a' }],
          next: 'nowhere',
        },
        { id: 'x', block: 'details', title: 'X', fields: [{ label: 'A', path: 'a' }] },
      ],
      cases: [{ name: 'only', inputs: {} }],
    });
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'duplicate step id "x"',
      'step "x" points at unknown step "nowhere"',
    ]);
  });

  it('rejects cases that target missing forms or fields, and duplicate case names', () => {
    const result = workflowSchema.safeParse({
      id: 'cases',
      name: 'Cases',
      published: true,
      steps: [
        { id: 'f', block: 'form', title: 'F', fields: [{ name: 'a', label: 'A', type: 'text' }] },
        { id: 'd', block: 'details', title: 'D', fields: [{ label: 'A', path: 'a' }] },
      ],
      cases: [
        { name: 'one', inputs: { f: { a: 'x', b: 'y' } } },
        { name: 'one', inputs: { d: { a: 'x' } } },
      ],
    });
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'case "one" sets unknown field "b" on "f"',
      'duplicate case name "one"',
      'case "one" has inputs for "d", which is not a form step',
    ]);
  });

  it('rejects a workflow with no UI step', () => {
    const result = workflowSchema.safeParse({
      id: 'headless',
      name: 'Headless',
      published: true,
      steps: [{ id: 'a', block: 'object', op: 'set', value: 1, into: 'a' }],
      cases: [{ name: 'only', inputs: {} }],
    });
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'a workflow needs at least one UI step',
    ]);
  });
});

describe('model-labelled rows and optional values', () => {
  it('labels every fetched row in place, leaving the fetched fields untouched', async () => {
    const wf = workflow('order-categories');
    const run = await engine.start(wf, 'r');
    const outcome = await engine.submit(wf, run, 'lookup', { customerId: 'C-1001' });
    if (outcome.kind !== 'advanced') throw new Error(outcome.kind);
    const orders = (outcome.run.state.customer as { orders: Record<string, unknown>[] }).orders;
    expect(outcome.run.currentStepId).toBe('orders');
    expect(orders.map((order) => order.id)).toEqual(['O-5001', 'O-5002', 'O-5003']);
    for (const order of orders) {
      expect(['office', 'electronics', 'stationery', 'furniture']).toContain(
        (order.label as { category: string }).category,
      );
    }
  });

  it('renders a page with a missing optional value instead of failing the run', async () => {
    const optional = workflowSchema.parse({
      id: 'optional',
      name: 'Optional',
      published: false,
      steps: [
        {
          id: 'show',
          block: 'details',
          title: 'Show',
          fields: [{ label: 'Maybe', path: 'not.there', optional: true }],
        },
      ],
      cases: [{ name: 'only', inputs: {} }],
    });
    const run = await engine.start(optional, 'r');
    expect(run).toMatchObject({ status: 'in-progress', currentStepId: 'show' });
  });

  it('stores textarea line breaks as \\n, however the browser sent them', async () => {
    const wf = workflow('invoice-extraction');
    const run = await engine.start(wf, 'r');
    const outcome = await engine.submit(wf, run, 'paste', {
      reference: 'x',
      invoiceText: 'Vendor: A\r\nAmount due: 5\rCurrency: EUR',
    });
    if (outcome.kind !== 'advanced') throw new Error(outcome.kind);
    expect(outcome.run.state.invoiceText).toBe('Vendor: A\nAmount due: 5\nCurrency: EUR');
  });

  it('requires an ai step to have exactly one of input or each', () => {
    const base = {
      id: 'ai',
      name: 'AI',
      published: false,
      cases: [{ name: 'only', inputs: {} }],
    };
    const ai = {
      id: 'ask',
      block: 'ai',
      prompt: 'p',
      output: { a: { type: 'string' } },
      into: 'out',
    };
    const show = {
      id: 'show',
      block: 'details',
      title: 'S',
      fields: [{ label: 'A', path: 'out' }],
    };
    const neither = workflowSchema.safeParse({ ...base, steps: [ai, show] });
    const both = workflowSchema.safeParse({
      ...base,
      steps: [{ ...ai, input: 'x', each: { rows: 'r', input: 'i' } }, show],
    });
    for (const result of [neither, both]) {
      expect(result.error?.issues.map((issue) => issue.message)).toEqual([
        'ai step "ask" needs exactly one of "input" or "each"',
      ]);
    }
  });
});
