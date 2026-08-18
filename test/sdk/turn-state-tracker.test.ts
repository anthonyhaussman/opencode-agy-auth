import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  TurnStateTracker,
  initTurnStateTracker,
  getTurnStateTracker,
  shutdownTurnStateTracker,
} from '../../src/sdk/request/turn-state-tracker.js';

describe('TurnStateTracker', () => {
  const tmpDir = path.join(os.tmpdir(), `turn-state-test-${Date.now()}`);

  beforeEach(() => {
    vi.stubEnv('XDG_CONFIG_HOME', tmpDir);
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterEach(() => {
    shutdownTurnStateTracker();
    vi.unstubAllEnvs();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('tracks turn states in memory and retrieves them', () => {
    const tracker = new TurnStateTracker(false);
    expect(tracker.getState('sess-1')).toBeUndefined();
    expect(tracker.needsThinkingRecovery('sess-1')).toBe(false);

    tracker.updateAfterResponse('sess-1', {
      inToolLoop: true,
      turnHasThinking: false,
      lastModelHasThinking: false,
      lastModelHasToolCalls: true,
    });

    expect(tracker.getState('sess-1')).toEqual({
      inToolLoop: true,
      turnHasThinking: false,
      lastModelHasThinking: false,
      lastModelHasToolCalls: true,
    });
    expect(tracker.needsThinkingRecovery('sess-1')).toBe(true);

    tracker.clear('sess-1');
    expect(tracker.getState('sess-1')).toBeUndefined();
    tracker.shutdown();
  });

  it('recovers from contents array', () => {
    const tracker = new TurnStateTracker(false);
    const contents = [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ functionCall: { name: 'calc' } }] },
      { role: 'user', parts: [{ functionResponse: { response: { output: 42 } } }] },
    ];

    const recovered = tracker.recoverFromContents('sess-rec', contents);
    expect(recovered.inToolLoop).toBe(true);
    expect(tracker.getState('sess-rec')).toEqual(recovered);

    tracker.shutdown();
  });

  it('persists and loads from disk with singleton functions', () => {
    const tracker = initTurnStateTracker();
    expect(getTurnStateTracker()).toBe(tracker);

    tracker.updateAfterResponse('sess-disk-1', {
      inToolLoop: false,
      turnHasThinking: true,
      lastModelHasThinking: true,
      lastModelHasToolCalls: false,
    });

    shutdownTurnStateTracker();
    expect(getTurnStateTracker()).toBeNull();

    // Reload from disk
    const tracker2 = new TurnStateTracker(true);
    expect(tracker2.getState('sess-disk-1')).toEqual({
      inToolLoop: false,
      turnHasThinking: true,
      lastModelHasThinking: true,
      lastModelHasToolCalls: false,
    });
    tracker2.shutdown();
  });
});
