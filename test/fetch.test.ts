import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { agyFetch } from "../src/fetch";

describe("fetch", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("calls native fetch directly when OPENCODE_AGY_AUTH_PROXY is not set", async () => {
    delete process.env.OPENCODE_AGY_AUTH_PROXY;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

    const res = await agyFetch("https://api.example.com", { method: "GET" });
    expect(await res.text()).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledWith("https://api.example.com", { method: "GET" });
  });

  it("passes proxy in request init when OPENCODE_AGY_AUTH_PROXY is set", async () => {
    process.env.OPENCODE_AGY_AUTH_PROXY = "http://127.0.0.1:8080";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("proxied"));

    const res = await agyFetch("https://api.example.com");
    expect(await res.text()).toBe("proxied");
    expect(fetchSpy).toHaveBeenCalledWith("https://api.example.com", expect.objectContaining({
      proxy: "http://127.0.0.1:8080"
    }));
  });
});
