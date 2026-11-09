import { EngineError } from '../engine/state.ts';
import { customers, rates } from './data.ts';

export interface MockResponse {
  status: number;
  body: unknown;
}

/**
 * The whole mock API as one pure function of the request path. The HTTP route
 * and the engine's `fetch` block both go through here, so they can't disagree.
 * Bodies are fresh copies so no caller can mutate the shared data.
 */
export function mockApiGet(path: string): MockResponse {
  const { pathname } = new URL(path, 'http://mock.invalid');
  let segments: string[];
  try {
    segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return { status: 400, body: { error: `malformed path "${pathname}"` } };
  }

  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'rates') {
    return { status: 200, body: structuredClone(rates) };
  }
  if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'customers') {
    const customer = customers.find((candidate) => candidate.id === segments[2]);
    return customer
      ? { status: 200, body: structuredClone(customer) }
      : { status: 404, body: { error: `no customer with id "${segments[2] ?? ''}"` } };
  }
  return { status: 404, body: { error: `no mock API route for "${pathname}"` } };
}

/**
 * What the engine's `fetch` block uses. It calls the mock API in-process
 * rather than over HTTP, through the same function the /api route serves.
 * A non-200 ends the run with an error page.
 */
export function fetchFromMockApi(path: string): Promise<unknown> {
  const response = mockApiGet(path);
  if (response.status !== 200) {
    return Promise.reject(new EngineError(`GET ${path} returned ${String(response.status)}`));
  }
  return Promise.resolve(response.body);
}
