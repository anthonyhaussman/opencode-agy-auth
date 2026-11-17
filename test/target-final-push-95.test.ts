import { describe, it, expect, vi } from 'vitest';
import { setOpenBrowserLauncherForTesting } from '../src/plugin/oauth-authorize.js';
import { createThoughtBuffer, deduplicateThinkingText } from '../src/sdk/request/thinking.js';
import { onboardManagedProject } from '../src/sdk/fetch_project.js';
import * as chatLoggerModule from '../src/sdk/chat-logger.js';
import * as retryModule from '../src/sdk/retry/index.js';

describe('Final Coverage Push', () => {

  it('covers deduplicateThinkingText empty content filter', () => {
    const resp = {
      content: [
        { type: 'thinking', thinking: 'initial' }
      ]
    };
    const sent = createThoughtBuffer();
    sent.set(0, 'initial');
    const hashes = new Set<string>();

    // Repeating exact text when filtered returns empty content array
    const deduped: any = deduplicateThinkingText(resp, sent, hashes);
    expect(deduped.content).toHaveLength(0);
  });

  it('covers thinking recovery and thought buffer methods', () => {
    const buffer = createThoughtBuffer();
    buffer.set(0, 'thought-part-1');
    expect(buffer.get(0)).toBe('thought-part-1');
    expect(buffer.get(1)).toBeUndefined();
    buffer.clear();
    expect(buffer.get(0)).toBeUndefined();
  });

  it('covers onboardManagedProject with undefined and non-empty project ids', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ done: true, response: { cloudaicompanionProject: { id: 'auto-proj' } } }), { status: 200 }));
    globalThis.fetch = mockFetch;

    const res = await onboardManagedProject('token', 'free-tier');
    expect(res).toBe('auto-proj');
  });

});
