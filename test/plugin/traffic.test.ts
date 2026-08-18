import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import {
  simulateClientBackgroundTraffic,
  buildTrajectoryAnalyticsBody,
} from '../../src/plugin/traffic.js';

describe('traffic simulation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds trajectory analytics body with default or custom parameters', () => {
    const body1 = buildTrajectoryAnalyticsBody('cascade-123', 'LINUX_AMD64');
    expect(body1).toBeDefined();
    expect(typeof body1).toBe('object');
    expect(body1.trajectory).toBeDefined();
    expect(body1.metadata).toBeDefined();
    expect(body1.metadata.ideType).toBe('ANTIGRAVITY');
    expect(body1.startStepIndex).toBe('0');

    const bodyDefault = buildTrajectoryAnalyticsBody();
    expect(bodyDefault).toBeDefined();
    expect(typeof bodyDefault).toBe('object');
  });

  it('triggers simulateClientBackgroundTraffic fire-and-forget calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    simulateClientBackgroundTraffic('access-token-123', 'project-123', 'gemini-2.5-pro');

    // Wait briefly for background promises to trigger
    await new Promise((r) => setTimeout(r, 100));
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('handles errors in background traffic endpoints', async () => {
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('Internal Server Error', { status: 500 });
      }
      if (callCount === 2) {
        return new Response('Bad Request', { status: 400 });
      }
      return new Response('{"ok": true}', { status: 200 });
    });

    simulateClientBackgroundTraffic('token-win', 'project-win', 'gemini-3.7-flash');
    await new Promise((r) => setTimeout(r, 100));
  });

  it('handles network error rejections in background traffic sendWithRetry', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network offline'));

    simulateClientBackgroundTraffic('token-err', 'project-err');
    await new Promise((r) => setTimeout(r, 100));
  });
});
