import { describe, expect, it } from "vitest";
import {
  clamp,
  pad,
  buildProgressBar,
  formatRemainingAmount,
  formatRelativeResetTime,
} from "../src/plugin/quota-utils";

describe("quota-utils", () => {
  describe("clamp", () => {
    it("returns min if value is NaN", () => {
      expect(clamp(Number.NaN, 0, 100)).toBe(0);
    });

    it("clamps value below minimum", () => {
      expect(clamp(-5, 0, 10)).toBe(0);
    });

    it("clamps value above maximum", () => {
      expect(clamp(15, 0, 10)).toBe(10);
    });

    it("returns value within range unchanged", () => {
      expect(clamp(5, 0, 10)).toBe(5);
    });
  });

  describe("pad", () => {
    it("pads strings shorter than width", () => {
      expect(pad("abc", 6)).toBe("abc   ");
    });

    it("does not truncate strings longer than or equal to width", () => {
      expect(pad("abcdef", 4)).toBe("abcdef");
      expect(pad("abcd", 4)).toBe("abcd");
    });
  });

  describe("buildProgressBar", () => {
    it("renders empty progress bar for 0 fraction", () => {
      expect(buildProgressBar(0, 10)).toBe("░".repeat(10));
    });

    it("renders full progress bar for >= 1 fraction", () => {
      expect(buildProgressBar(1, 10)).toBe("▓".repeat(10));
      expect(buildProgressBar(1.5, 10)).toBe("▓".repeat(10));
    });

    it("renders partial progress correctly", () => {
      expect(buildProgressBar(0.5, 10)).toBe("▓".repeat(5) + "░".repeat(5));
    });
  });

  describe("formatRemainingAmount", () => {
    it("returns undefined for empty or undefined input", () => {
      expect(formatRemainingAmount(undefined)).toBeUndefined();
      expect(formatRemainingAmount("")).toBeUndefined();
    });

    it("formats valid numeric strings with commas", () => {
      expect(formatRemainingAmount("1000000")).toBe("1,000,000");
    });

    it("returns raw string if not a finite number", () => {
      expect(formatRemainingAmount("unlimited")).toBe("unlimited");
    });
  });

  describe("formatRelativeResetTime", () => {
    it("returns undefined for invalid or missing date", () => {
      expect(formatRelativeResetTime(undefined)).toBeUndefined();
      expect(formatRelativeResetTime("invalid-date")).toBeUndefined();
    });

    it("returns 'reset pending' if date is in the past", () => {
      const past = new Date(Date.now() - 10000).toISOString();
      expect(formatRelativeResetTime(past)).toBe("reset pending");
    });

    it("formats future hours and minutes", () => {
      const future = new Date(Date.now() + 65 * 60 * 1000).toISOString();
      expect(formatRelativeResetTime(future)).toMatch(/^resets in 1h \d+m$/);
    });
  });
});
