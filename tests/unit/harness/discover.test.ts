import { describe, expect, it } from 'vitest';
import { discoverWorkflows } from '../../../harness/discover.ts';
import { HarnessError } from '../../../harness/errors.ts';
import { parseWorkflow } from '../../../harness/workflow.ts';

const details = { id: 'show', block: 'details', fields: [{ path: 'x' }] };
const published = {
  id: 'one',
  name: 'One',
  published: true,
  steps: [details],
  cases: [{ name: 'only', inputs: {} }],
};

function respond(status: number, body: unknown): typeof fetch {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

describe('discoverWorkflows', () => {
  it('returns parsed published workflows', async () => {
    const workflows = await discoverWorkflows('http://app', respond(200, [published]));
    expect(workflows.map((workflow) => workflow.id)).toEqual(['one']);
  });

  it('fails on an empty list instead of running zero tests', async () => {
    await expect(discoverWorkflows('http://app', respond(200, []))).rejects.toThrow(
      'refusing to run zero tests',
    );
  });

  it('fails when only unpublished workflows come back', async () => {
    const draft = { ...published, published: false };
    await expect(discoverWorkflows('http://app', respond(200, [draft]))).rejects.toThrow(
      'refusing to run zero tests',
    );
  });

  it('fails on an API error status', async () => {
    await expect(discoverWorkflows('http://app', respond(500, {}))).rejects.toThrow(
      'GET http://app/api/workflows returned 500',
    );
  });

  it('fails when the API is unreachable', async () => {
    const down: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    await expect(discoverWorkflows('http://app', down)).rejects.toThrow(HarnessError);
  });

  it('fails on a body that is not a list', async () => {
    await expect(discoverWorkflows('http://app', respond(200, { workflows: [] }))).rejects.toThrow(
      'did not return a list',
    );
  });

  it('fails on a workflow with no cases', async () => {
    const caseless = { ...published, cases: [] };
    await expect(discoverWorkflows('http://app', respond(200, [caseless]))).rejects.toThrow(
      'has no cases',
    );
  });
});

describe('parseWorkflow', () => {
  it('fails loudly on a block the harness cannot mirror', () => {
    const unknown = { ...published, steps: [{ id: 'x', block: 'teleport' }] };
    expect(() => parseWorkflow(unknown)).toThrow('unsupported block "teleport"');
  });

  it('rejects operands that are neither literals nor refs', () => {
    const bad = {
      ...published,
      steps: [{ id: 'm', block: 'math', op: 'add', args: [1, { value: 2 }], into: 'x' }, details],
    };
    expect(() => parseWorkflow(bad)).toThrow('steps[0](m).args[1].ref: expected a string');
  });

  it('defaults form fields to required, like the app', () => {
    const withForm = {
      ...published,
      steps: [{ id: 'f', block: 'form', fields: [{ name: 'a', label: 'A', type: 'text' }] }],
    };
    const [step] = parseWorkflow(withForm).steps;
    expect(step).toMatchObject({ block: 'form', fields: [{ name: 'a', required: true }] });
  });
});
