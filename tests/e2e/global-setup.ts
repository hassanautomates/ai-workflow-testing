import { clearManifests } from '../../harness/manifest.ts';

/** Start each run with an empty manifest folder, so the summary only reflects this run. */
export default async function globalSetup(): Promise<void> {
  await clearManifests();
}
