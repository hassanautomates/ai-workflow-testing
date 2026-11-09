import { describe, expect, it } from 'vitest';
import { HarnessError } from '../../../harness/errors.ts';
import { Mirror, type MirrorFetch } from '../../../harness/mirror.ts';
import { roundHalfAwayFromZero } from '../../../harness/values.ts';
import { parseWorkflow } from '../../../harness/workflow.ts';

const noFetch: MirrorFetch = () => Promise.reject(new Error('unexpected fetch'));

function workflow(steps: unknown[]) {
  return parseWorkflow({ id: 'w', name: 'W', published: true, steps, cases: [] });
}

const form = {
  id: 'in',
  block: 'form',
  fields: [
    { name: 'qty', type: 'number' },
    { name: 'price', type: 'number' },
  ],
};

const pricing = workflow([
  form,
  {
    id: 'sub',
    block: 'math',
    op: 'mul',
    args: [{ ref: 'qty' }, { ref: 'price' }],
    decimals: 2,
    into: 'sub',
  },
  {
    id: 'big',
    block: 'condition',
    if: { left: { ref: 'sub' }, cmp: 'gte', right: 100 },
    then: 'off',
    else: 'none',
  },
  { id: 'off', block: 'object', op: 'set', value: 'yes', into: 'discounted', next: 'show' },
  { id: 'none', block: 'object', op: 'set', value: 'no', into: 'discounted' },
  { id: 'show', block: 'details', fields: [{ path: 'sub' }, { path: 'discounted' }] },
]);

describe('Mirror', () => {
  it('stops at the first UI step', async () => {
    const mirror = await Mirror.start(pricing, noFetch);
    expect(mirror.screen).toMatchObject({ kind: 'step', step: { id: 'in' } });
  });

  it('parses number inputs, computes, and follows the branch the values pick', async () => {
    const small = await Mirror.start(pricing, noFetch);
    await small.submit({ qty: '3', price: '19.99' });
    expect(small.screen).toMatchObject({ kind: 'step', step: { id: 'show' } });
    expect(small.expected('sub')).toEqual({ path: 'sub', value: 59.97 });
    expect(small.expected('discounted').value).toBe('no');

    const big = await Mirror.start(pricing, noFetch);
    await big.submit({ qty: '6', price: '19.99' });
    expect(big.expected('sub').value).toBe(119.94);
    expect(big.expected('discounted').value).toBe('yes');
  });

  it('predicts completion after the last UI step', async () => {
    const mirror = await Mirror.start(pricing, noFetch);
    await mirror.submit({ qty: '1', price: '1' });
    await mirror.submit();
    expect(mirror.screen).toEqual({ kind: 'complete' });
    await expect(mirror.submit()).rejects.toThrow(HarnessError);
  });

  it('refuses a case that leaves a required field empty or gives a bad number', async () => {
    const mirror = await Mirror.start(pricing, noFetch);
    await expect(mirror.submit({ qty: '1' })).rejects.toThrow('leaves required "in.price" empty');
    await expect(mirror.submit({ qty: 'x', price: '1' })).rejects.toThrow('gives "x"');
  });

  it('replays fetch and predicts an error page when the API says no', async () => {
    const lookup = workflow([
      { id: 'in', block: 'form', fields: [{ name: 'id', type: 'text' }] },
      { id: 'load', block: 'fetch', path: '/api/things/{{id}}', into: 'thing' },
      { id: 'show', block: 'details', fields: [{ path: 'thing.name' }] },
    ]);
    const requested: string[] = [];
    const fetchJson: MirrorFetch = (path) => {
      requested.push(path);
      return Promise.resolve(
        path.endsWith('/ok') ? { status: 200, body: { name: 'Thing' } } : { status: 404, body: {} },
      );
    };

    const found = await Mirror.start(lookup, fetchJson);
    await found.submit({ id: 'ok' });
    expect(found.expected('thing.name').value).toBe('Thing');

    const missing = await Mirror.start(lookup, fetchJson);
    await missing.submit({ id: 'a b/c' });
    expect(missing.screen).toEqual({
      kind: 'error',
      reason: 'GET /api/things/a%20b%2Fc returned 404',
    });
    expect(requested).toEqual(['/api/things/ok', '/api/things/a%20b%2Fc']);
  });

  it('predicts an error page when a UI step would show a missing value', async () => {
    const broken = workflow([{ id: 'show', block: 'details', fields: [{ path: 'nothing' }] }]);
    const mirror = await Mirror.start(broken, noFetch);
    expect(mirror.screen).toEqual({ kind: 'error', reason: 'state has no value at "nothing"' });
  });

  it('runs string and object blocks, and copies on write so values never alias', async () => {
    const shapes = workflow([
      { id: 'in', block: 'form', fields: [{ name: 'raw', type: 'text' }] },
      { id: 't', block: 'string', op: 'trim', args: [{ ref: 'raw' }], into: 'word' },
      { id: 'u', block: 'string', op: 'upper', args: [{ ref: 'word' }], into: 'shout' },
      {
        id: 'c',
        block: 'string',
        op: 'concat',
        args: [{ ref: 'shout' }, '-', 1, null, true],
        into: 'joined',
      },
      { id: 'tpl', block: 'string', op: 'template', template: '<{{ word }}>', into: 'wrapped' },
      { id: 'a', block: 'object', op: 'set', value: { ref: 'word' }, into: 'box.word' },
      { id: 'b', block: 'object', op: 'set', value: { ref: 'box' }, into: 'copy' },
      { id: 'c2', block: 'object', op: 'set', value: 'changed', into: 'copy.word' },
      { id: 'p', block: 'object', op: 'pick', from: 'box', fields: ['word'], into: 'picked' },
      { id: 'm', block: 'object', op: 'merge', sources: ['box', 'copy'], into: 'merged' },
      { id: 'show', block: 'details', fields: [{ path: 'merged.word' }] },
    ]);
    const mirror = await Mirror.start(shapes, noFetch);
    await mirror.submit({ raw: '  hi ' });
    expect(mirror.expected('joined').value).toBe('HI-1true');
    expect(mirror.expected('wrapped').value).toBe('<hi>');
    expect(mirror.expected('box').value).toEqual({ word: 'hi' });
    expect(mirror.expected('picked').value).toEqual({ word: 'hi' });
    expect(mirror.expected('merged').value).toEqual({ word: 'changed' });
  });

  it('predicts an error on division by zero', async () => {
    const divide = workflow([
      { id: 'd', block: 'math', op: 'div', args: [1, 0], into: 'x' },
      { id: 'show', block: 'details', fields: [{ path: 'x' }] },
    ]);
    const mirror = await Mirror.start(divide, noFetch);
    expect(mirror.screen).toEqual({ kind: 'error', reason: 'step "d" divides by zero' });
  });

  it('throws a harness error when asked for a value it never computed', async () => {
    const mirror = await Mirror.start(pricing, noFetch);
    expect(() => mirror.expected('nope')).toThrow(HarnessError);
  });
});

describe('roundHalfAwayFromZero', () => {
  it.each([
    [1.005, 2, 1.01],
    [4.947525, 2, 4.95],
    [11.994, 2, 11.99],
    [2.5, 0, 3],
    [-2.5, 0, -3],
    [-0.001, 2, 0],
    [1e-7, 2, 0],
  ])('rounds %d to %d places as %d', (value, decimals, expected) => {
    expect(roundHalfAwayFromZero(value, decimals)).toBe(expected);
  });

  it('never returns -0', () => {
    expect(Object.is(roundHalfAwayFromZero(-0.001, 2), -0)).toBe(false);
  });
});
