import { writeSummary } from '../../harness/manifest.ts';

/** After all tests: totals per workflow in reports/manifest/summary.md. */
export default async function globalTeardown(): Promise<void> {
  const path = await writeSummary();
  console.log(`coverage summary: ${path}`);
}
