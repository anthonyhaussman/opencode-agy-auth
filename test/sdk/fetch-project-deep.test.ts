import { describe, it, expect, vi } from 'vitest';
import { onboardManagedProject } from '../../src/sdk/fetch_project';
import * as fetchModule from '../../src/fetch';

describe('fetch_project onboardManagedProject deep coverage', () => {
  it('throws ProjectIdRequiredError when non-free-tier onboarding is called without a projectId', async () => {
    await expect(
      onboardManagedProject('access-tok', 'premium-tier', undefined)
    ).rejects.toThrow('Google Gemini/Agy requires a Google Cloud project');
  });

  it('handles polling operation that succeeds after 2 iterations', async () => {
    let callCount = 0;
    vi.spyOn(fetchModule, 'agyFetch').mockImplementation(async (input: any) => {
      callCount += 1;
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes(':onboardUser')) {
        return new Response(
          JSON.stringify({ done: false, name: 'operations/op-123' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('operations/op-123')) {
        if (callCount === 2) {
          return new Response(
            JSON.stringify({ done: false, name: 'operations/op-123' }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            done: true,
            response: { cloudaicompanionProject: { id: 'managed-proj-id' } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    });

    const managedId = await onboardManagedProject('access-tok', 'free-tier', undefined, undefined, 5, 1);
    expect(managedId).toBe('managed-proj-id');
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it('returns undefined if polling operation request fails', async () => {
    vi.spyOn(fetchModule, 'agyFetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes(':onboardUser')) {
        return new Response(
          JSON.stringify({ done: false, name: 'operations/op-fail' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('Server error', { status: 500 });
    });

    const result = await onboardManagedProject('access-tok', 'free-tier', undefined, undefined, 2, 1);
    expect(result).toBeUndefined();
  });

  it('returns explicit user projectId if done but no cloudaicompanionProject id is returned', async () => {
    vi.spyOn(fetchModule, 'agyFetch').mockResolvedValue(
      new Response(
        JSON.stringify({ done: true, response: {} }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const result = await onboardManagedProject('access-tok', 'custom-tier', 'my-explicit-project', undefined, 1, 1);
    expect(result).toBe('my-explicit-project');
  });

  it('returns undefined and warns if initial onboard response is not ok', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(fetchModule, 'agyFetch').mockResolvedValue(
      new Response('Forbidden', { status: 403, statusText: 'Forbidden' })
    );

    const result = await onboardManagedProject('access-tok', 'free-tier', undefined);
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});
