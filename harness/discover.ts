import { HarnessError } from './errors.ts';
import type { MirrorFetch } from './mirror.ts';
import { type Workflow, parseWorkflow } from './workflow.ts';

/**
 * Lists the workflows to test, straight from the running app. Tests are
 * generated from this at load time, so a new published workflow is covered
 * without anyone writing a test for it.
 *
 * It never returns an empty list: an API error or zero workflows throws, so
 * the run fails instead of passing with nothing tested.
 */
export async function discoverWorkflows(
  baseURL: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Workflow[]> {
  const url = `${baseURL}/api/workflows`;
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new HarnessError(`GET ${url} failed: ${String(error)}`);
  }
  if (!response.ok) throw new HarnessError(`GET ${url} returned ${String(response.status)}`);

  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new HarnessError(`GET ${url} did not return a list`);

  // The endpoint should only list published workflows; filter anyway so an
  // app bug there can't put a draft under test.
  const workflows = body
    .map((item, i) => parseWorkflow(item, `workflows[${String(i)}]`))
    .filter((workflow) => workflow.published);

  if (workflows.length === 0) {
    throw new HarnessError(`GET ${url} listed no published workflows; refusing to run zero tests`);
  }
  for (const workflow of workflows) {
    if (workflow.cases.length === 0) {
      throw new HarnessError(`workflow "${workflow.id}" has no cases, so it can't be tested`);
    }
  }
  return workflows;
}

export interface ServerInfo {
  aiSeed: string;
  /** The deliberate defect the app is running with, if any. */
  engineBug: string | null;
}

/**
 * The AI_SEED (and ENGINE_BUG, if any) the running app uses, from /healthz.
 * Read from the app rather than the environment: the app picks a random seed
 * when none is set, and a reused dev server may have been started differently.
 */
export async function readServerInfo(
  baseURL: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ServerInfo> {
  const url = `${baseURL}/healthz`;
  const response = await fetchImpl(url);
  if (!response.ok) throw new HarnessError(`GET ${url} returned ${String(response.status)}`);
  const body: unknown = await response.json();
  const info = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (typeof info.aiSeed !== 'string' || info.aiSeed === '') {
    throw new HarnessError(`GET ${url} did not report an aiSeed`);
  }
  const engineBug = typeof info.engineBug === 'string' ? info.engineBug : null;
  return { aiSeed: info.aiSeed, engineBug };
}

/** Replays a fetch block's GET against the live mock API. */
export function httpFetch(baseURL: string, fetchImpl: typeof fetch = fetch): MirrorFetch {
  return async (path) => {
    const response = await fetchImpl(`${baseURL}${path}`);
    const body: unknown = await response.json();
    return { status: response.status, body };
  };
}
