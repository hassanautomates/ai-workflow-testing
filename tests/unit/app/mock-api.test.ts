import { describe, expect, it } from 'vitest';
import { mockApiGet } from '../../../app/mock-api/index.ts';

describe('mock API', () => {
  it('returns the same response for the same request, every time', () => {
    for (const path of [
      '/api/customers/C-1001',
      '/api/rates',
      '/api/customers/missing',
      '/api/nope',
    ]) {
      const first = JSON.stringify(mockApiGet(path));
      for (let i = 0; i < 5; i++) expect(JSON.stringify(mockApiGet(path))).toBe(first);
    }
  });

  it('hands out copies, so a caller mutating a body cannot change later responses', () => {
    const first = mockApiGet('/api/customers/C-1001').body as { firstName: string };
    first.firstName = 'Changed';
    expect(mockApiGet('/api/customers/C-1001').body).toMatchObject({ firstName: 'Mira' });
  });

  it('ignores query strings and decodes path segments', () => {
    expect(mockApiGet('/api/customers/C%2D1002?x=1')).toMatchObject({
      status: 200,
      body: { id: 'C-1002' },
    });
  });

  it('answers 404 for unknown customers and routes, 400 for malformed paths', () => {
    expect(mockApiGet('/api/customers/C-0000').status).toBe(404);
    expect(mockApiGet('/api/orders').status).toBe(404);
    expect(mockApiGet('/api/customers/%E0%A4%A').status).toBe(400);
  });
});
