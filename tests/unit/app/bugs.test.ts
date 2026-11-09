import { describe, expect, it } from 'vitest';
import { createBlockHandlers } from '../../../app/engine/blocks.ts';
import { engineBugs, withEngineBug } from '../../../app/engine/bugs.ts';
import { createEngine } from '../../../app/engine/engine.ts';
import { fetchFromMockApi } from '../../../app/mock-api/index.ts';
import { loadWorkflows } from '../../../app/workflows/load.ts';

const handlers = createBlockHandlers({ aiSeed: 'unit-test' });
const workflows = loadWorkflows();

async function runOrderTotal(bug: string | undefined, quantity: string) {
  const workflow = workflows.find((candidate) => candidate.id === 'order-total');
  if (!workflow) throw new Error('order-total missing');
  const engine = createEngine({
    handlers: withEngineBug(handlers, bug),
    fetchJson: fetchFromMockApi,
  });
  const run = await engine.start(workflow, 'r');
  const outcome = await engine.submit(workflow, run, 'order', { quantity, unitPrice: '19.99' });
  if (outcome.kind !== 'advanced') throw new Error(outcome.kind);
  return outcome.run.state;
}

describe('ENGINE_BUG', () => {
  it('is off by default and leaves the handlers untouched', () => {
    expect(withEngineBug(handlers, undefined)).toBe(handlers);
    expect(withEngineBug(handlers, '')).toBe(handlers);
  });

  it('refuses unknown names instead of silently running clean', () => {
    expect(() => withEngineBug(handlers, 'nope')).toThrow('unknown ENGINE_BUG "nope"');
  });

  it('every registered bug changes what the engine computes or where it goes', async () => {
    const clean = await runOrderTotal(undefined, '3');
    for (const bug of ['math-off-by-one', 'wrong-branch', 'round-toward-zero']) {
      expect(await runOrderTotal(bug, '3'), bug).not.toEqual(clean);
    }
  });

  it('round-toward-zero truncates where the engine rounds half away from zero', async () => {
    expect((await runOrderTotal(undefined, '3')).tax).toBe(4.95);
    expect((await runOrderTotal('round-toward-zero', '3')).tax).toBe(4.94);
  });

  it('has a target and a description for the proof report', () => {
    for (const bug of Object.values(engineBugs)) {
      expect(bug.target).not.toBe('');
      expect(bug.description).not.toBe('');
    }
    expect(Object.keys(engineBugs)).toHaveLength(5);
  });
});
