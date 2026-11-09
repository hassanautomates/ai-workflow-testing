import { randomInt } from 'node:crypto';

/**
 * AI_SEED fixes the simulated model's choices for this server. Unset means a
 * fresh random seed per server start: that is how variance is produced on
 * purpose. The seed in use is logged and served on /healthz so a test run can
 * report it, and rerunning with AI_SEED=<that seed> reproduces it exactly.
 */
export function resolveAiSeed(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.AI_SEED?.trim();
  return fromEnv ? fromEnv : String(randomInt(1, 2 ** 31));
}
