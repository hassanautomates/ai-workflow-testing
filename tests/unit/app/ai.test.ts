import { describe, expect, it } from 'vitest';
import { contractViolations } from '../../../app/ai/contract.ts';
import { resolveAiSeed } from '../../../app/ai/seed.ts';
import { simulateModel } from '../../../app/ai/simulate.ts';
import type { AiStep, OutputRule } from '../../../app/engine/schema.ts';
import { loadWorkflows } from '../../../app/workflows/load.ts';

const workflows = loadWorkflows();

/** Every ai block in the shipped workflows, with the input its first case feeds it. */
const aiCalls = workflows.flatMap((workflow) =>
  workflow.steps
    .filter((step): step is AiStep => step.block === 'ai')
    .map((step) => {
      const ref = typeof step.input === 'object' && step.input !== null ? step.input.ref : '';
      const inputs = Object.assign({}, ...Object.values(workflow.cases[0]?.inputs ?? {})) as Record<
        string,
        string
      >;
      return { workflow: workflow.id, step, input: inputs[ref] ?? '' };
    }),
);

function call(step: AiStep, input: string, seed: string) {
  return simulateModel({ seed, stepId: step.id, prompt: step.prompt, input, output: step.output });
}

describe('simulated model', () => {
  it('ships ai blocks to test', () => {
    expect(aiCalls.map((c) => c.workflow).sort()).toEqual([
      'invoice-extraction',
      'invoice-total',
      'ticket-triage',
    ]);
  });

  it('stays inside every declared contract across 500 seeds', () => {
    for (const { step, input } of aiCalls) {
      for (let seed = 0; seed < 500; seed++) {
        expect(contractViolations(call(step, input, String(seed)), step.output)).toEqual([]);
      }
    }
  });

  it('gives the same answer, in the same field order, for the same seed', () => {
    for (const { step, input } of aiCalls) {
      expect(JSON.stringify(call(step, input, '77'))).toBe(JSON.stringify(call(step, input, '77')));
    }
  });

  it('varies wording, field order, confidence and optional fields across seeds', () => {
    const extraction = aiCalls.find((c) => c.workflow === 'invoice-extraction');
    if (!extraction) throw new Error('no extraction step');
    const answers = Array.from({ length: 50 }, (_, seed) =>
      call(extraction.step, extraction.input, String(seed)),
    );
    expect(new Set(answers.map((a) => Object.keys(a).join(','))).size).toBeGreaterThan(5);
    expect(new Set(answers.map((a) => a.vendor)).size).toBeGreaterThan(1);
    expect(new Set(answers.map((a) => a.confidence)).size).toBeGreaterThan(10);
    expect(answers.some((a) => 'dueDate' in a)).toBe(true);
    expect(answers.some((a) => !('dueDate' in a))).toBe(true);
  });
});

describe('contractViolations', () => {
  const output: Record<string, OutputRule> = {
    amount: { type: 'number', required: true, min: 0, max: 10, decimals: 1 },
    label: { type: 'string', required: true, allowed: ['a'] },
    note: { type: 'string', required: false },
  };

  it('accepts output inside the contract, with or without optional fields', () => {
    expect(contractViolations({ amount: 2.5, label: 'a' }, output)).toEqual([]);
    expect(contractViolations({ label: 'a', amount: 0, note: 'x' }, output)).toEqual([]);
  });

  it('names each way output breaks the contract', () => {
    expect(contractViolations({ amount: 11.25, label: 'b', extra: true }, output)).toEqual([
      'amount is above max',
      'amount has too many decimals',
      'label is not allowed',
      'extra is not in the contract',
    ]);
    expect(contractViolations({ amount: 1 }, output)).toEqual(['label is missing']);
  });
});

describe('resolveAiSeed', () => {
  it('uses AI_SEED when set and a fresh random seed when not', () => {
    expect(resolveAiSeed({ AI_SEED: ' 42 ' })).toBe('42');
    const randoms = new Set(Array.from({ length: 5 }, () => resolveAiSeed({})));
    expect(randoms.size).toBeGreaterThan(1);
  });
});
