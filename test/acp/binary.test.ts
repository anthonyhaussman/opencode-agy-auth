import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareVersions, defaultExec, probeAgy, resolveAgyPath } from "../../src/acp/binary";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "agy-bin-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function makeExe(name: string, mode = 0o755): Promise<string> {
  const p = path.join(dir, name);
  await writeFile(p, "#!/bin/sh\necho hi\n");
  await chmod(p, mode);
  return p;
}

describe("compareVersions", () => {
  it("compares", () => {
    expect(compareVersions("1.5.10", "1.5.10")).toBe(0);
    expect(compareVersions("1.5.10", "1.5.9")).toBeGreaterThan(0);
    expect(compareVersions("1.4.99", "1.5.0")).toBeLessThan(0);
    expect(compareVersions("1.5", "1.5.0")).toBe(0);
  });
});

describe("resolveAgyPath", () => {
  it("prefers OPENCODE_AGY_PATH when executable", async () => {
    const p = await makeExe("custom-agy");
    expect(await resolveAgyPath({ OPENCODE_AGY_PATH: p, PATH: "" })).toBe(p);
  });

  it("falls back to PATH when override is not executable", async () => {
    const bad = await makeExe("bad", 0o644);
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), "agy-empty-"));
    try {
      expect(await resolveAgyPath({ OPENCODE_AGY_PATH: bad, PATH: emptyDir })).toBeNull();
      const good = await makeExe("agy");
      expect(await resolveAgyPath({ OPENCODE_AGY_PATH: bad, PATH: dir })).toBe(good);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("finds agy on PATH, skipping empty entries", async () => {
    const good = await makeExe("agy");
    expect(await resolveAgyPath({ PATH: ["", dir].join(path.delimiter) })).toBe(good);
  });

  it("returns null when nothing found or PATH unset", async () => {
    expect(await resolveAgyPath({ PATH: dir })).toBeNull();
    expect(await resolveAgyPath({})).toBeNull();
  });

  it("uses process.env by default", async () => {
    await resolveAgyPath();
  });
});

describe("probeAgy", () => {
  it("returns missing without a path", async () => {
    expect(await probeAgy({ PATH: dir })).toEqual({ status: "missing" });
  });

  it("returns too_old", async () => {
    const p = await makeExe("agy");
    const exec = async () => ({ stdout: "agy 1.5.9\n", stderr: "" });
    expect(await probeAgy({ PATH: dir }, exec)).toEqual({ status: "too_old", path: p, version: "1.5.9" });
  });

  it("returns ready", async () => {
    const p = await makeExe("agy");
    const exec = async (file: string, args: string[]) => {
      expect(file).toBe(p);
      expect(args).toEqual(["--version"]);
      return { stdout: "agy 1.5.10", stderr: "" };
    };
    expect(await probeAgy({ PATH: dir }, exec)).toEqual({ status: "ready", path: p, version: "1.5.10" });
  });

  it("returns failed when exec throws an Error", async () => {
    const p = await makeExe("agy");
    const exec = async () => {
      throw new Error("boom");
    };
    expect(await probeAgy({ PATH: dir }, exec)).toEqual({ status: "failed", path: p, error: "boom" });
  });

  it("returns failed when exec throws a non-Error", async () => {
    const p = await makeExe("agy");
    const exec = async () => {
      throw "nope";
    };
    expect(await probeAgy({ PATH: dir }, exec)).toEqual({ status: "failed", path: p, error: "nope" });
  });

  it("returns failed on unparseable version", async () => {
    const p = await makeExe("agy");
    const exec = async () => ({ stdout: "garbage", stderr: "" });
    const r = await probeAgy({ PATH: dir }, exec);
    expect(r).toMatchObject({ status: "failed", path: p });
    expect((r as { error: string }).error).toMatch(/version/i);
  });

  it("uses defaultExec and process env defaults", async () => {
    const p = await makeExe("agy");
    const r = await probeAgy({ OPENCODE_AGY_PATH: p });
    expect(r.status).toBe("failed");
  });
});

describe("defaultExec", () => {
  it("runs a binary without a shell", async () => {
    const p = await makeExe("echoer");
    const r = await defaultExec(p, [], { env: { PATH: "/usr/bin:/bin" } });
    expect(r.stdout).toContain("hi");
  });

  it("works without opts", async () => {
    const p = await makeExe("echoer2");
    const r = await defaultExec(p, []);
    expect(r.stdout).toContain("hi");
  });
});
