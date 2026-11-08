import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_SANDBOX_POLICY,
  concurrencyRefusal,
  findSecretLike,
  isSandboxResource,
  monthlyCapRefusal,
  redactSecrets,
  usageMonth,
} from "../src/machine-backend.ts";
import { sandboxNameForKey } from "../src/machine-backend-server.ts";

describe("frontend-safe machine-backend", () => {
  it("imports nothing but zod", () => {
    const source = readFileSync(new URL("../src/machine-backend.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    expect(imports).toEqual(["zod"]);
  });

  it("defaults to the BCS guards", () => {
    expect(DEFAULT_SANDBOX_POLICY).toEqual({
      idleMinutes: 15,
      ttlMinutes: 120,
      ttlRenewMinutes: 15,
      maxConcurrent: 2,
      monthlyCapUsd: 30,
      hourlyRateUsd: null,
      orphanGraceMinutes: 10,
      orphans: "remove",
    });
  });

  it("writes refusals that name the cap", () => {
    expect(concurrencyRefusal("Boat", 1, 2)).toBeNull();
    expect(concurrencyRefusal("Boat", 2, 2)).toContain("2 of 2 sandboxes are already running");
    expect(concurrencyRefusal("Boat", 9, null)).toBeNull();
    expect(monthlyCapRefusal("Boat", { month: "2026-11", runningMs: 0, estimatedUsd: 29.99, capUsd: 30 })).toBeNull();
    expect(monthlyCapRefusal("Boat", { month: "2026-11", runningMs: 0, estimatedUsd: 30, capUsd: 30 })).toBe(
      "Boat: the monthly cap of $30.00 is reached ($30.00 used in 2026-11). Raise the cap in the plugin settings or wait for next month.",
    );
  });

  it("finds credential-like keys and values", () => {
    expect(findSecretLike({ size: "small", region: "eu" })).toBeNull();
    expect(findSecretLike({ auth: { apiKey: "x" } })).toBe("$.auth.apiKey");
    expect(findSecretLike({ apiKey: "" })).toBeNull();
    expect(findSecretLike({ notes: ["fine", "sk-ant-api03-abcdefghijkl"] })).toBe("$.notes[1]");
  });

  it("redacts tokens from vendor messages", () => {
    const text = redactSecrets('failed: {"token":"abc123"} Bearer abc.def.ghi github_pat_ABCDEFGHIJKLMNOPQRSTUV_x');
    expect(text).not.toMatch(/abc123|abc\.def|ABCDEFGHIJ/);
  });

  it("validates resources and buckets usage by UTC month", () => {
    expect(isSandboxResource({ v: 1 })).toBe(false);
    expect(usageMonth(Date.UTC(2026, 0, 31, 23, 59))).toBe("2026-01");
  });

  it("derives stable vendor-safe names from keys", () => {
    expect(sandboxNameForKey("thr_abc")).toBe(sandboxNameForKey("thr_abc"));
    expect(sandboxNameForKey("abc-123")).toBe("bb-abc-123");
    expect(sandboxNameForKey("thr_ABC")).not.toBe(sandboxNameForKey("thr_abc"));
    expect(sandboxNameForKey("x".repeat(200)).length).toBeLessThanOrEqual(48);
    expect(sandboxNameForKey("thr_abc")).toMatch(/^[a-z0-9-]+$/);
  });
});
