import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { analyzeConversationState, type ConversationState } from "./thinking";

export type TurnState = Pick<ConversationState, "inToolLoop" | "turnHasThinking" | "lastModelHasThinking" | "lastModelHasToolCalls">;

interface TurnStateRecord {
  state: TurnState;
  updatedAt: number;
}

interface TurnStateData {
  version: "1.0";
  entries: Record<string, TurnStateRecord>;
  updatedAt: number;
}

const WRITE_THROTTLE_MS = 5000;

function getConfigDir(): string {
  const platform = process.platform;
  if (platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

function getTurnStateFilePath(): string {
  return join(getConfigDir(), "antigravity-turn-states.json");
}

function loadTurnStatesFromDisk(): Map<string, TurnStateRecord> {
  const result = new Map<string, TurnStateRecord>();
  try {
    const filePath = getTurnStateFilePath();
    if (!existsSync(filePath)) {
      return result;
    }

    const content = readFileSync(filePath, "utf-8");
    const data = JSON.parse(content) as TurnStateData;
    if (data.version !== "1.0") {
      return result;
    }

    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000;
    for (const [key, record] of Object.entries(data.entries)) {
      if (record.state && typeof record.state === "object" && now - record.updatedAt < maxAge) {
        result.set(key, record);
      }
    }
  } catch {
  }
  return result;
}

function saveTurnStatesToDisk(entries: Map<string, TurnStateRecord>): boolean {
  try {
    const filePath = getTurnStateFilePath();
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000;
    const serializable: Record<string, TurnStateRecord> = {};
    for (const [key, record] of entries.entries()) {
      if (now - record.updatedAt < maxAge) {
        serializable[key] = record;
      }
    }

    const data: TurnStateData = {
      version: "1.0",
      entries: serializable,
      updatedAt: now,
    };

    const tmpPath = join(tmpdir(), `antigravity-turn-states-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(data), "utf-8");

    try {
      renameSync(tmpPath, filePath);
    } catch {
      writeFileSync(filePath, readFileSync(tmpPath));
      try {
        unlinkSync(tmpPath);
      } catch {
      }
    }

    return true;
  } catch {
    return false;
  }
}

export class TurnStateTracker {
  private entries = new Map<string, TurnStateRecord>();
  private dirty = false;
  private lastWriteTime = 0;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.entries = loadTurnStatesFromDisk();
  }

  getState(sessionId: string): TurnState | undefined {
    const record = this.entries.get(sessionId);
    if (!record) return undefined;
    return record.state;
  }

  needsThinkingRecovery(sessionId: string): boolean {
    const state = this.entries.get(sessionId);
    if (!state) return false;
    return state.state.inToolLoop && !state.state.turnHasThinking;
  }

  updateAfterResponse(sessionId: string, newState: TurnState): void {
    this.entries.set(sessionId, { state: newState, updatedAt: Date.now() });
    this.dirty = true;
    this.scheduleThrottledWrite();
  }

  recoverFromContents(sessionId: string, contents: any[]): TurnState {
    const fullState = analyzeConversationState(contents);
    const turnState: TurnState = {
      inToolLoop: fullState.inToolLoop,
      turnHasThinking: fullState.turnHasThinking,
      lastModelHasThinking: fullState.lastModelHasThinking,
      lastModelHasToolCalls: fullState.lastModelHasToolCalls,
    };
    this.entries.set(sessionId, { state: turnState, updatedAt: Date.now() });
    this.dirty = true;
    this.scheduleThrottledWrite();
    return turnState;
  }

  clear(sessionId: string): void {
    this.entries.delete(sessionId);
    this.dirty = true;
    this.scheduleThrottledWrite();
  }

  shutdown(): void {
    this.clearWriteTimer();
    if (this.dirty) {
      saveTurnStatesToDisk(this.entries);
      this.dirty = false;
    }
  }

  private scheduleThrottledWrite(): void {
    if (this.writeTimer) {
      return;
    }

    const elapsed = Date.now() - this.lastWriteTime;
    const remaining = Math.max(0, WRITE_THROTTLE_MS - elapsed);

    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.lastWriteTime = Date.now();
      if (this.dirty) {
        this.dirty = false;
        saveTurnStatesToDisk(this.entries);
      }
    }, remaining);

    if (this.writeTimer && typeof this.writeTimer === "object" && "unref" in this.writeTimer) {
      this.writeTimer.unref();
    }
  }

  private clearWriteTimer(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
  }
}

let trackerInstance: TurnStateTracker | null = null;

export function initTurnStateTracker(): TurnStateTracker {
  if (!trackerInstance) {
    trackerInstance = new TurnStateTracker();
  }
  return trackerInstance;
}

export function getTurnStateTracker(): TurnStateTracker | null {
  return trackerInstance;
}

export function shutdownTurnStateTracker(): void {
  if (trackerInstance) {
    trackerInstance.shutdown();
    trackerInstance = null;
  }
}
