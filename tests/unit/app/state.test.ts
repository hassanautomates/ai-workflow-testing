import { describe, expect, it } from 'vitest';
import {
  EngineError,
  fillTemplate,
  getPath,
  roundTo,
  setPath,
  toDisplayString,
} from '../../../app/engine/state.ts';

describe('getPath', () => {
  const state = { a: { b: [{ c: 1 }, { c: 2 }] }, zero: 0 };

  it('reads nested objects and array indices', () => {
    expect(getPath(state, 'a.b.1.c')).toBe(2);
    expect(getPath(state, 'zero')).toBe(0);
  });

  it('throws on missing paths instead of returning undefined', () => {
    expect(() => getPath(state, 'a.x')).toThrow(EngineError);
    expect(() => getPath(state, 'a.b.5.c')).toThrow(EngineError);
    expect(() => getPath(state, 'zero.toFixed')).toThrow(EngineError);
  });
});

describe('setPath', () => {
  it('returns a new state and leaves the original untouched', () => {
    const original = { a: { keep: true } };
    const next = setPath(original, 'a.b', 1);
    expect(next).toEqual({ a: { keep: true, b: 1 } });
    expect(original).toEqual({ a: { keep: true } });
  });

  it('creates missing parents', () => {
    expect(setPath({}, 'x.y.z', 'v')).toEqual({ x: { y: { z: 'v' } } });
  });

  it('writes into an existing array by index without touching the original', () => {
    const original = { rows: [{ id: 1 }, { id: 2 }] };
    expect(setPath(original, 'rows.1.label', 'b')).toEqual({
      rows: [{ id: 1 }, { id: 2, label: 'b' }],
    });
    expect(original.rows[1]).toEqual({ id: 2 });
  });
});

describe('roundTo', () => {
  it.each([
    [1.005, 2, 1.01],
    [4.947525, 2, 4.95],
    [2.5, 0, 3],
    [-2.5, 0, -3],
    [-0.001, 2, 0],
    [1e-7, 2, 0],
  ])('roundTo(%d, %d) = %d', (value, decimals, expected) => {
    expect(roundTo(value, decimals)).toBe(expected);
  });

  it('never returns -0', () => {
    expect(Object.is(roundTo(-0.001, 2), -0)).toBe(false);
  });
});

describe('templates and display', () => {
  it('fills placeholders from state', () => {
    expect(fillTemplate('{{ n }} × {{p.q}}', { n: 3, p: { q: 'x' } })).toBe('3 × x');
  });

  it('encodes values when asked, for fetch paths', () => {
    expect(fillTemplate('/api/customers/{{id}}', { id: 'a/b c' }, encodeURIComponent)).toBe(
      '/api/customers/a%2Fb%20c',
    );
  });

  it('displays null as empty and objects as JSON', () => {
    expect(toDisplayString(null)).toBe('');
    expect(toDisplayString({ a: 1 })).toBe('{"a":1}');
    expect(toDisplayString(0)).toBe('0');
  });
});
