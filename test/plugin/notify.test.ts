import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  maybeShowAgyCapacityToast,
  maybeShowAgyTestToast,
} from '../../src/plugin/notify.js';

describe('notify', () => {
  beforeEach(() => {
    vi.stubEnv('OPENCODE_AGY_TEST_TOAST', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('shows capacity toast on RESOURCE_EXHAUSTED 429 response with retry info', async () => {
    const clientMock = {
      tui: {
        showToast: vi.fn().mockResolvedValue(undefined),
      },
    };

    const errorPayload = {
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message: 'Quota exceeded',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            domain: 'cloudcode-pa.googleapis.com',
            reason: 'MODEL_CAPACITY_EXHAUSTED',
          },
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '60s',
          },
        ],
      },
    };

    const response = new Response(JSON.stringify(errorPayload), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });

    await maybeShowAgyCapacityToast(clientMock as any, response, 'project-123', 'gemini-2.5-pro');

    expect(clientMock.tui.showToast).toHaveBeenCalledWith({
      body: expect.objectContaining({
        variant: 'warning',
      }),
    });
  });

  it('does not show toast for non-quota error', async () => {
    const clientMock = {
      tui: {
        showToast: vi.fn(),
      },
    };

    const response = new Response(JSON.stringify({ error: { message: 'Invalid argument' } }), {
      status: 400,
    });

    await maybeShowAgyCapacityToast(clientMock as any, response, 'project-123');
    expect(clientMock.tui.showToast).not.toHaveBeenCalled();
  });

  it('shows test toast when requested', async () => {
    const clientMock = {
      tui: {
        showToast: vi.fn().mockResolvedValue(undefined),
      },
    };

    await maybeShowAgyTestToast(clientMock as any, 'project-test');
    expect(clientMock.tui.showToast).toHaveBeenCalledWith({
      body: expect.objectContaining({
        variant: 'info',
      }),
    });

    // Second call for same project shouldn't re-trigger
    await maybeShowAgyTestToast(clientMock as any, 'project-test');
    expect(clientMock.tui.showToast).toHaveBeenCalledTimes(1);
  });

  it('bypasses test toast when env var is disabled or missing tui', async () => {
    vi.stubEnv('OPENCODE_AGY_TEST_TOAST', '0');
    const clientMock = {
      tui: {
        showToast: vi.fn(),
      },
    };

    await maybeShowAgyTestToast(clientMock as any, 'project-disabled');
    expect(clientMock.tui.showToast).not.toHaveBeenCalled();

    await maybeShowAgyTestToast({} as any, 'project-no-tui');
  });

  it('handles toast cooldown and unknown reason for capacity toast', async () => {
    const clientMock = {
      tui: {
        showToast: vi.fn().mockResolvedValue(undefined),
      },
    };

    const errorPayload = {
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            domain: 'cloudcode-pa.googleapis.com',
            reason: 'MODEL_CAPACITY_EXHAUSTED',
          },
        ],
      },
    };

    const res1 = new Response(JSON.stringify(errorPayload), { status: 429 });
    await maybeShowAgyCapacityToast(clientMock as any, res1, 'project-cd', 'model-cd');
    expect(clientMock.tui.showToast).toHaveBeenCalledTimes(1);

    // Call immediately again (cooldown active)
    const res2 = new Response(JSON.stringify(errorPayload), { status: 429 });
    await maybeShowAgyCapacityToast(clientMock as any, res2, 'project-cd', 'model-cd');
    expect(clientMock.tui.showToast).toHaveBeenCalledTimes(1);
  });

});
