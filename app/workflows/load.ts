import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type Workflow, workflowSchema } from '../engine/schema.ts';

export const workflowsDir = import.meta.dirname;

/**
 * Loads every `*.json` in the directory. Any invalid file throws, naming the
 * file and the problem, so the server refuses to start with a broken workflow.
 * Sorted by id so listings are stable.
 */
export function loadWorkflows(dir: string = workflowsDir): Workflow[] {
  const workflows = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const path = join(dir, file);
      const parsed = workflowSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (!parsed.success) {
        throw new Error(`invalid workflow ${file}:\n${parsed.error.message}`);
      }
      if (parsed.data.id !== basename(file, '.json')) {
        throw new Error(
          `workflow ${file} has id "${parsed.data.id}"; the id must match the file name`,
        );
      }
      return parsed.data;
    });
  // Plain code-unit order, not localeCompare, so the order can't vary by machine locale.
  return workflows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
