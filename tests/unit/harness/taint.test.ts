import type { Locator } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { assertExact, assertShape } from '../../../harness/assertions.ts';
import { HarnessError } from '../../../harness/errors.ts';
import { Mirror, type MirrorFetch, screenKey } from '../../../harness/mirror.ts';
import { parseWorkflow } from '../../../harness/workflow.ts';

const noFetch: MirrorFetch = () => Promise.reject(new Error('unexpected fetch'));

function workflow(steps: unknown[]) {
  return parseWorkflow({ id: 'w', name: 'W', published: true, steps, cases: [] });
}

const textForm = { id: 'in', block: 'form', fields: [{ name: 'text', type: 'textarea' }] };

const extract = {
  id: 'extract',
  block: 'ai',
  prompt: 'Extract',
  input: { ref: 'text' },
  output: {
    amount: { type: 'number', min: 0, max: 100, decimals: 2 },
    label: { type: 'string', allowed: ['a', 'b'] },
    note: { type: 'string', required: false, maxLength: 20 },
  },
  into: 'ai',
};

/** Starts a mirror for `steps` and submits the text form, if there is one. */
async function mirrorAfterForm(steps: unknown[], fetchJson = noFetch) {
  const mirror = await Mirror.start(workflow(steps), fetchJson);
  await mirror.submit({ text: 'Amount: 42.00' });
  return mirror;
}

describe('assertExact on tainted values', () => {
  // The element is never touched: the refusal happens before any comparison.
  const untouchable = {} as Locator;

  it('throws a HarnessError instead of comparing model output exactly', async () => {
    const mirror = await mirrorAfterForm([
      textForm,
      extract,
      { id: 'show', block: 'details', fields: [{ path: 'ai.amount' }] },
    ]);
    const tainted = mirror.expected('ai.amount');
    expect(tainted.tainted).toBe(true);
    await expect(assertExact(untouchable, tainted)).rejects.toThrow(HarnessError);
    await expect(assertExact(untouchable, tainted)).rejects.toThrow(
      'refusing to compare "ai.amount" exactly',
    );
  });

  it('also refuses values computed from model output', async () => {
    const mirror = await mirrorAfterForm([
      textForm,
      extract,
      { id: 'double', block: 'math', op: 'mul', args: [{ ref: 'ai.amount' }, 2], into: 'doubled' },
      { id: 'show', block: 'details', fields: [{ path: 'doubled' }] },
    ]);
    await expect(assertExact(untouchable, mirror.expected('doubled'))).rejects.toThrow(
      HarnessError,
    );
  });

  it('assertShape refuses clean values, which must be checked exactly', async () => {
    const mirror = await mirrorAfterForm([
      textForm,
      { id: 'show', block: 'details', fields: [{ path: 'text' }] },
    ]);
    await expect(assertShape(untouchable, mirror.expected('text'))).rejects.toThrow(HarnessError);
  });
});

describe('taint sources', () => {
  it('marks each ai output field tainted with the rule declared in the JSON', async () => {
    const mirror = await mirrorAfterForm([
      textForm,
      extract,
      { id: 'show', block: 'details', fields: [{ path: 'ai.amount' }] },
    ]);
    expect(mirror.expected('ai.amount')).toMatchObject({
      tainted: true,
      rule: { type: 'number', required: true, min: 0, max: 100, decimals: 2 },
      origin: 'ai "extract" → amount',
    });
    expect(mirror.expected('ai.label').rule).toMatchObject({ allowed: ['a', 'b'] });
    expect(mirror.expected('ai.note').rule).toMatchObject({ required: false, maxLength: 20 });
  });

  it('marks a generated id tainted, with its format as the shape', async () => {
    const mirror = await Mirror.start(
      workflow([
        { id: 'ref', block: 'id', prefix: 'ORD-', length: 6, alphabet: 'ABC123', into: 'ref' },
        { id: 'show', block: 'details', fields: [{ path: 'ref' }] },
      ]),
      noFetch,
    );
    expect(mirror.expected('ref')).toMatchObject({
      tainted: true,
      rule: { type: 'string', minLength: 10, maxLength: 10, pattern: '^ORD\\-[ABC123]{6}$' },
    });
  });
});

describe('field-level taint', () => {
  it('taints only the object field that came from the model', async () => {
    const mirror = await mirrorAfterForm([
      textForm,
      extract,
      { id: 'a', block: 'object', op: 'set', value: 'Ana', into: 'order.customer' },
      { id: 'b', block: 'object', op: 'set', value: { ref: 'ai.label' }, into: 'order.label' },
      { id: 'c', block: 'object', op: 'pick', from: 'order', fields: ['customer'], into: 'picked' },
      { id: 'show', block: 'details', fields: [{ path: 'order.customer' }] },
    ]);
    expect(mirror.expected('order.customer')).toMatchObject({ tainted: false, value: 'Ana' });
    expect(mirror.expected('order.label').tainted).toBe(true);
    // Picking only the clean field leaves no taint behind.
    expect(mirror.expected('picked')).toMatchObject({ tainted: false, value: { customer: 'Ana' } });
    // The object as a whole holds model output, so it is shape-checked, with
    // the clean field pinned exactly inside the shape.
    expect(mirror.expected('order')).toMatchObject({
      tainted: true,
      rule: {
        type: 'object',
        fields: {
          customer: { type: 'exact', value: 'Ana' },
          label: { type: 'string', allowed: ['a', 'b'] },
        },
      },
    });
  });

  it('taints only the table cell that came from the model', async () => {
    const rows: MirrorFetch = () =>
      Promise.resolve({ status: 200, body: [{ id: 'r1' }, { id: 'r2' }] });
    const mirror = await mirrorAfterForm(
      [
        textForm,
        { id: 'load', block: 'fetch', path: '/api/rows', into: 'rows' },
        extract,
        {
          id: 'label',
          block: 'object',
          op: 'set',
          value: { ref: 'ai.label' },
          into: 'rows.0.label',
        },
        { id: 'show', block: 'details', fields: [{ path: 'rows.0.id' }] },
      ],
      rows,
    );
    expect(mirror.rowCount('rows')).toBe(2);
    expect(mirror.expected('rows.0.label').tainted).toBe(true);
    expect(mirror.expected('rows.0.id')).toMatchObject({ tainted: false, value: 'r1' });
    expect(mirror.expected('rows.1.id')).toMatchObject({ tainted: false, value: 'r2' });
  });
});

describe('taint propagation', () => {
  it('derives a numeric range for math on model output', async () => {
    const mirror = await mirrorAfterForm([
      textForm,
      extract,
      { id: 'rate', block: 'object', op: 'set', value: 0.2, into: 'rate' },
      {
        id: 'tax',
        block: 'math',
        op: 'mul',
        args: [{ ref: 'ai.amount' }, { ref: 'rate' }],
        decimals: 2,
        into: 'tax',
      },
      {
        id: 'total',
        block: 'math',
        op: 'add',
        args: [{ ref: 'ai.amount' }, { ref: 'tax' }],
        decimals: 2,
        into: 'total',
      },
      { id: 'show', block: 'details', fields: [{ path: 'total' }] },
    ]);
    expect(mirror.expected('rate')).toMatchObject({ tainted: false, value: 0.2 });
    expect(mirror.expected('tax').rule).toEqual({
      type: 'number',
      required: true,
      min: 0,
      max: 20,
      decimals: 2,
    });
    expect(mirror.expected('total').rule).toEqual({
      type: 'number',
      required: true,
      min: 0,
      max: 120,
      decimals: 2,
    });
  });

  it('gives templates over model output a minimum length from their clean parts', async () => {
    const mirror = await mirrorAfterForm([
      textForm,
      extract,
      { id: 'msg', block: 'string', op: 'template', template: 'Label: {{ai.label}}!', into: 'msg' },
      { id: 'show', block: 'details', fields: [{ path: 'msg' }] },
    ]);
    expect(mirror.expected('msg').rule).toEqual({ type: 'string', required: true, minLength: 8 });
  });

  it('predicts the app failing when model output of the wrong type meets math', async () => {
    const mirror = await mirrorAfterForm([
      textForm,
      extract,
      { id: 'bad', block: 'math', op: 'add', args: [{ ref: 'ai.label' }, 1], into: 'x' },
      { id: 'show', block: 'details', fields: [{ path: 'x' }] },
    ]);
    expect(mirror.screen).toMatchObject({ kind: 'error', code: 'wrong-type' });
  });
});

describe('observed routing', () => {
  const branching = [
    textForm,
    extract,
    {
      id: 'big',
      block: 'condition',
      if: { left: { ref: 'ai.amount' }, cmp: 'gte', right: 50 },
      then: 'high',
      else: 'low',
    },
    { id: 'high', block: 'details', fields: [{ path: 'ai.amount' }], next: 'end' },
    { id: 'low', block: 'details', fields: [{ path: 'ai.amount' }] },
    { id: 'end', block: 'details', fields: [{ path: 'text' }] },
  ];

  it('offers every branch the condition allows when it reads model output', async () => {
    const mirror = await mirrorAfterForm(branching);
    expect(mirror.options.map(screenKey)).toEqual(['step:high', 'step:low']);
    expect(() => mirror.screen).toThrow(HarnessError);
  });

  it('rejects a rendered screen that is not one of the branches', async () => {
    const mirror = await mirrorAfterForm(branching);
    expect(() => mirror.observe('step:end')).toThrow('not one of the valid branches');
  });

  it('continues from the observed branch, with the model value narrowed by it', async () => {
    const high = await mirrorAfterForm(branching);
    high.observe('step:high');
    expect(high.expected('ai.amount').rule).toMatchObject({ min: 50, max: 100 });

    const low = await mirrorAfterForm(branching);
    low.observe('step:low');
    // Strictly below 50, with two decimals: at most 49.99.
    expect(low.expected('ai.amount').rule).toMatchObject({ min: 0, max: 49.99 });
    await low.submit();
    expect(low.screen).toMatchObject({ kind: 'step', step: { id: 'end' } });
    expect(low.expected('text')).toMatchObject({ tainted: false, value: 'Amount: 42.00' });
  });

  it('merges branches that reach the same screen, tainting what differs between them', async () => {
    const mirror = await mirrorAfterForm([
      textForm,
      extract,
      {
        id: 'which',
        block: 'condition',
        if: { left: { ref: 'ai.label' }, cmp: 'eq', right: 'a' },
        then: 'set-a',
        else: 'set-b',
      },
      { id: 'set-a', block: 'object', op: 'set', value: 'went a', into: 'route', next: 'show' },
      { id: 'set-b', block: 'object', op: 'set', value: 'went b', into: 'route' },
      { id: 'show', block: 'details', fields: [{ path: 'route' }, { path: 'text' }] },
    ]);
    expect(mirror.options.map(screenKey)).toEqual(['step:show']);
    expect(mirror.expected('route')).toMatchObject({
      tainted: true,
      rule: { type: 'string', allowed: ['went a', 'went b'] },
    });
    // What both branches agree on stays clean.
    expect(mirror.expected('text').tainted).toBe(false);
  });
});

describe('model-labelled rows', () => {
  const rows: MirrorFetch = () =>
    Promise.resolve({
      status: 200,
      body: [
        { id: 'r1', item: 'Lamp' },
        { id: 'r2', item: 'Desk' },
      ],
    });
  const labelled = [
    textForm,
    { id: 'load', block: 'fetch', path: '/api/rows', into: 'rows' },
    {
      id: 'label',
      block: 'ai',
      prompt: 'Label',
      each: { rows: 'rows', input: 'item' },
      output: { category: { type: 'string', allowed: ['home', 'office'] } },
      into: 'tag',
    },
    { id: 'show', block: 'table', rows: 'rows', columns: [{ key: 'id' }, { key: 'tag.category' }] },
  ];

  it('keeps fetched cells clean and taints only the model-written cell in each row', async () => {
    const mirror = await mirrorAfterForm(labelled, rows);
    expect(mirror.rowCount('rows')).toBe(2);
    for (const i of [0, 1]) {
      expect(mirror.expected(`rows.${String(i)}.id`).tainted).toBe(false);
      expect(mirror.expected(`rows.${String(i)}.item`).tainted).toBe(false);
      expect(mirror.expected(`rows.${String(i)}.tag.category`)).toMatchObject({
        tainted: true,
        rule: { allowed: ['home', 'office'] },
        origin: `ai "label" row ${String(i)} → category`,
      });
    }
  });

  it('predicts the app failing when a row lacks the input field', async () => {
    const broken: MirrorFetch = () => Promise.resolve({ status: 200, body: [{ id: 'r1' }] });
    const mirror = await mirrorAfterForm(labelled, broken);
    expect(mirror.screen).toMatchObject({ kind: 'error', code: 'missing-value' });
  });
});

describe('optional values', () => {
  const optional = [
    textForm,
    extract,
    {
      id: 'show',
      block: 'details',
      fields: [
        { path: 'ai.note', optional: true },
        { path: 'never.set', optional: true },
        { path: 'text', optional: true },
      ],
    },
  ];

  it('says whether an optional value is there, missing, or up to the model', async () => {
    const mirror = await mirrorAfterForm(optional);
    expect(mirror.screen).toMatchObject({ kind: 'step', step: { id: 'show' } });
    expect(mirror.presence('ai.note')).toMatchObject({
      presence: 'maybe',
      expected: { tainted: true },
    });
    expect(mirror.presence('never.set')).toEqual({ presence: 'absent' });
    expect(mirror.presence('text')).toMatchObject({
      presence: 'present',
      expected: { tainted: false },
    });
  });
});
