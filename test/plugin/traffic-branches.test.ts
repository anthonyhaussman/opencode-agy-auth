import { describe, it, expect, vi, beforeEach } from 'vitest';
import { simulateClientBackgroundTraffic } from '../../src/plugin/traffic.js';
import * as helpers from '../../src/sdk/retry/helpers.js';

describe('traffic sendWithRetry branches', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('handles 500 error then success retry in sendWithRetry', async () => {
    let attempts = 0;
    vi.spyOn(helpers, 'wait').mockResolvedValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        return new Response('Server error', { status: 503 });
      }
      return new Response('{"ok": true}', { status: 200 });
    });

    simulateClientBackgroundTraffic('token-503', 'project-503');
    await new Promise((r) => setTimeout(r, 50));
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  it('handles network error then retry success in sendWithRetry', async () => {
    let attempts = 0;
    vi.spyOn(helpers, 'wait').mockResolvedValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('fetch failed');
      }
      return new Response('{"ok": true}', { status: 200 });
    });

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    simulateClientBackgroundTraffic('token-net-retry', 'project-net-retry');
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 100));
    expect(attempts).toBeGreaterThanOrEqual(2);
  });
});
