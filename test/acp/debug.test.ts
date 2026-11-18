import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgyDebugLog } from "../../src/acp/debug";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "agy-debug-"));

describe("createAgyDebugLog", () => {
  it("is disabled unless AGY_ACP_DEBUG=1", () => {
    expect(createAgyDebugLog({})).toBeUndefined();
    expect(createAgyDebugLog({ AGY_ACP_DEBUG: "0" })).toBeUndefined();
  });

  it("writes timestamped lines to the data dir by default", () => {
    const dir = tmp();
    const log = createAgyDebugLog({ AGY_ACP_DEBUG: "1", XDG_DATA_HOME: dir });
    log!("spawn", "pid=1");
    const file = path.join(dir, "opencode", "agy-acp", "debug.log");
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ spawn pid=1\n$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("honours AGY_ACP_DEBUG_FILE", () => {
    const file = path.join(tmp(), "nested", "x.log");
    createAgyDebugLog({ AGY_ACP_DEBUG: "1", AGY_ACP_DEBUG_FILE: file })!("a", "b");
    expect(readFileSync(file, "utf8")).toContain(" a b\n");
  });

  it("redacts the given secrets", () => {
    const file = path.join(tmp(), "x.log");
    const log = createAgyDebugLog({ AGY_ACP_DEBUG: "1", AGY_ACP_DEBUG_FILE: file }, ["s3cret", undefined, ""]);
    log!("out", '{"token":"s3cret","again":"s3cret"}');
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("s3cret");
    expect(text).toContain('{"token":"[redacted]","again":"[redacted]"}');
  });

  it("never throws when the file cannot be written", () => {
    const dir = tmp();
    const log = createAgyDebugLog({ AGY_ACP_DEBUG: "1", AGY_ACP_DEBUG_FILE: dir });
    expect(() => log!("a")).not.toThrow();
    expect(existsSync(path.join(dir, "a"))).toBe(false);
  });
});
