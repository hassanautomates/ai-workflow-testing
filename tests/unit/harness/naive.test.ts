import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HarnessError } from '../../../harness/errors.ts';
import { Fixture, harnessMode } from '../../../harness/naive.ts';

describe('harnessMode', () => {
  it('is taint-aware unless asked otherwise', () => {
    expect(harnessMode({})).toBe('taint');
    expect(harnessMode({ HARNESS_MODE: '' })).toBe('taint');
    expect(harnessMode({ HARNESS_MODE: 'naive' })).toBe('naive');
    expect(harnessMode({ HARNESS_MODE: 'naive-record' })).toBe('naive-record');
  });

  it('refuses unknown modes', () => {
    expect(() => harnessMode({ HARNESS_MODE: 'loose' })).toThrow(HarnessError);
  });
});

describe('Fixture', () => {
  it('saves what one run showed and gives it back to the next', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fixtures-'));
    const recording = Fixture.recording('wf', 'A case', '7');
    recording.saveRoute(2, 'step:review');
    recording.saveValue(2, '[data-field="x"]', 'shown');
    recording.saveValue(2, '[data-field="maybe"]', null);
    await recording.write(dir);

    const loaded = await Fixture.load('wf', 'A case', dir);
    expect(loaded.mode).toBe('naive');
    expect(loaded.recordedSeed).toBe('7');
    expect(loaded.route(2)).toBe('step:review');
    expect(loaded.value(2, '[data-field="x"]')).toBe('shown');
    expect(loaded.value(2, '[data-field="maybe"]')).toBeNull();
    expect(loaded.value(3, '[data-field="x"]')).toBeUndefined();
  });

  it('fails clearly when nothing was recorded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fixtures-'));
    await expect(Fixture.load('wf', 'missing', dir)).rejects.toThrow(
      'record one with HARNESS_MODE',
    );
  });
});
