import { describe, expect, it } from 'vitest';
import { createBlockHandlers } from '../../../app/engine/blocks.ts';
import type { IdStep } from '../../../app/engine/schema.ts';

const step: IdStep = {
  id: 'ref',
  block: 'id',
  prefix: 'ORD-',
  length: 8,
  alphabet: '23456789ABCDEFGHJKMNPQRSTVWXYZ',
  into: 'ref',
};

async function generate(seed: string, state: Record<string, unknown> = { name: 'Ana' }) {
  const handlers = createBlockHandlers({ aiSeed: seed });
  const result = await handlers.id(step, { state, fetchJson: () => Promise.resolve(null) });
  return result.state.ref as string;
}

describe('generated ids', () => {
  it('match the declared format', async () => {
    expect(await generate('1')).toMatch(/^ORD-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
  });

  it('are reproduced exactly by the same seed and run', async () => {
    expect(await generate('42')).toBe(await generate('42'));
  });

  it('differ between seeds, and between runs with different inputs', async () => {
    expect(await generate('42')).not.toBe(await generate('43'));
    expect(await generate('42', { name: 'Ana' })).not.toBe(await generate('42', { name: 'Ben' }));
  });

  it("don't depend on how many ids or model calls happened before", async () => {
    const handlers = createBlockHandlers({ aiSeed: '42' });
    const ctx = { state: { name: 'Ana' }, fetchJson: () => Promise.resolve(null) };
    await handlers.id(step, ctx);
    await handlers.id(step, ctx);
    expect((await handlers.id(step, ctx)).state.ref).toBe(await generate('42'));
  });
});
