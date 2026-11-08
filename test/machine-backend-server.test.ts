import { describe, expect, it } from "bun:test";
import { registerSandboxBackend } from "../src/machine-backend-server.ts";
import { Clock, fakeBackend, fakeBb, report } from "./sandbox-fakes.ts";
import { setup, signal } from "./sandbox-harness.ts";

describe("registration", () => {
  it("registers the machine provider, the composed project-checkout environment and a minute sweep", () => {
    const t = setup();
    expect(t.sdk.machine.id).toBe("fake-sandbox");
    expect(t.sdk.machine.ephemeral).toBe(true);
    expect(t.sdk.state.environment).toMatchObject({
      id: "fake-sandbox",
      machineProviderId: "fake-sandbox",
      environmentProviderId: "project-checkout",
    });
    expect(t.sdk.schedules.map((s) => [s.name, s.cron])).toEqual([["sandbox-sweep", "* * * * *"]]);
  });
});

describe("create", () => {
  it("checkpoints before allocating, bootstraps through the vendor exec, and returns a secret-free resource", async () => {
    const t = setup();
    const { result, checkpoints, lines, hostId } = await t.create("thr_abc");
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.name).toBe("Fake Sandbox abcdef");
    expect(checkpoints[0]).toMatchObject({ state: "allocating", sandboxId: null, key: "thr_abc" });
    expect(checkpoints.at(-1)).toMatchObject({ state: "running", sandboxId: "sb-1", init: "none", meta: { region: "eu" } });
    expect(t.fake.calls.create).toBe(1);
    expect(t.sdk.state.bootstraps).toEqual([{ key: "thr_abc" }]);
    expect(t.fake.calls.exec.some(([id, , , script]) => id === "sb-1" && script === "install")).toBe(true);
    expect(lines.some((line) => line.includes("No systemd"))).toBe(true);
    expect(await t.allocation(checkpoints[0]!.name)).toMatchObject({ state: "running", hostId, sandboxId: "sb-1" });
    expect(JSON.stringify(result.resource)).not.toMatch(/token|secret/i);
  });

  it("records systemd when the image has it", async () => {
    const t = setup({ hourlyRateUsd: 0.5 }, "systemd");
    const { checkpoints, lines } = await t.create("thr_sd");
    expect(checkpoints.at(-1)?.init).toBe("systemd");
    expect(lines.some((line) => line.includes("No systemd"))).toBe(false);
  });

  it("is idempotent by key: a retried attempt reuses the running sandbox", async () => {
    const t = setup();
    t.sdk.state.bootstrapFault = new Error("daemon never connected");
    const first = await t.create("thr_retry");
    expect(first.result).toEqual({ status: "failed", message: "daemon never connected" });
    expect(first.checkpoints.at(-1)).toMatchObject({ state: "running", sandboxId: "sb-1" });
    t.sdk.state.bootstrapFault = null;
    const second = await t.create("thr_retry", 2);
    expect(second.result.status).toBe("created");
    expect(t.fake.calls.create).toBe(1);
    expect(second.lines.some((line) => line.includes("Reusing Fake Sandbox sandbox sb-1 from an earlier attempt"))).toBe(true);
  });

  it("recovers a crashed create through reconcileCleanup by key", async () => {
    const t = setup();
    t.sdk.state.bootstrapFault = new Error("server restarted");
    const crashed = await t.create("thr_crash");
    const name = crashed.checkpoints[0]!.name;
    expect(t.fake.sandboxes.size).toBe(1);
    const progress = report();
    const cleaned = await t.sdk.machine.reconcileCleanup({ key: "thr_crash", report: progress.progress, signal: signal() });
    expect(cleaned).toEqual({ status: "removed" });
    expect(t.fake.sandboxes.size).toBe(0);
    expect(await t.allocation(name)).toBeUndefined();
  });

  it("reports reconcileCleanup failure while the allocation is still present", async () => {
    const t = setup();
    t.sdk.state.bootstrapFault = new Error("boom");
    await t.create("thr_stuck");
    t.fake.faults.keepAfterRemove = true;
    const cleaned = await t.sdk.machine.reconcileCleanup({ key: "thr_stuck", report: report().progress, signal: signal() });
    expect(cleaned.status).toBe("failed");
    if (cleaned.status === "failed") expect(cleaned.message).toContain("still present");
  });

  it("redacts vendor errors before they reach the user", async () => {
    const t = setup();
    t.fake.faults.create = new Error("401 from vendor: Authorization: Bearer abcdefghijklmnopqrstuvwxyz");
    const { result } = await t.create("thr_err");
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.message).not.toContain("abcdefghijklmnop");
      expect(result.message).toContain("[redacted]");
    }
  });

  it("refuses credential-like inputs and metadata", async () => {
    const t = setup();
    const decision = await t.sdk.machine.validate!({ inputs: { apiToken: "x" } as never });
    expect(decision).toMatchObject({ action: "refuse" });
    t.fake.faults.meta = { note: "ghp_abcdefghijklmnopqrstuvwxyz0123" };
    const { result } = await t.create("thr_meta");
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.message).toContain("credential-like");
  });
});

describe("guards", () => {
  it("refuses a third concurrent sandbox with a message naming the cap", async () => {
    const t = setup();
    await t.create("thr_1");
    await t.create("thr_2");
    const third = await t.create("thr_3");
    expect(third.result).toEqual({
      status: "failed",
      message:
        "Fake Sandbox: 2 of 2 sandboxes are already running (max concurrent 2). Suspend or remove one, or raise the limit in the plugin settings.",
    });
    expect(t.fake.calls.create).toBe(2);
    expect(await t.sdk.machine.validate!({ inputs: null as never })).toMatchObject({ action: "refuse" });
    expect(await t.registration.refusal()).toContain("max concurrent 2");
  });

  it("frees a concurrency slot on suspend and refuses resume when full", async () => {
    const t = setup({ hourlyRateUsd: 0.5, maxConcurrent: 1 });
    const a = await t.create("thr_a");
    await t.suspend(a.hostId!);
    const b = await t.create("thr_b");
    expect(b.result.status).toBe("created");
    await expect(t.resume(a.hostId!)).rejects.toThrow("1 of 1 sandbox is already running");
  });

  it("refuses create past the monthly cap and marks the provider unavailable", async () => {
    const t = setup({ hourlyRateUsd: 1, monthlyCapUsd: 1, maxConcurrent: null });
    const a = await t.create("thr_cap");
    t.clock.advance(61);
    const usage = await t.registration.usage();
    expect(usage.estimatedUsd).toBeCloseTo(61 / 60, 5);
    const refused = await t.create("thr_cap2");
    expect(refused.result.status).toBe("failed");
    if (refused.result.status === "failed") {
      expect(refused.result.message).toContain("monthly cap of $1.00 is reached ($1.02 used in 2026-11)");
    }
    expect(await t.sdk.machine.availability!()).toMatchObject({ status: "unavailable" });
    await t.suspend(a.hostId!);
    t.clock.advance(600);
    expect((await t.registration.usage()).runningMs).toBe(61 * 60_000);
  });

  it("asks for an hourly rate when a cap is set without one", async () => {
    const t = setup({});
    expect(await t.sdk.machine.availability!()).toEqual({
      status: "setup-required",
      message: "Fake Sandbox: set an hourly rate so the $30.00 monthly cap can be enforced.",
    });
    const { result } = await t.create("thr_norate");
    expect(result.status).toBe("failed");
  });

  it("reads a policy function on every check", async () => {
    let max = 1;
    const clock = new Clock();
    const sdk = fakeBb(clock);
    const fake = fakeBackend(clock);
    const registration = registerSandboxBackend(sdk.bb, fake.backend, () => ({ hourlyRateUsd: 0, maxConcurrent: max }), { now: clock.now });
    await sdk.machine.create({ key: "k1", attempt: 1, inputs: null as never, checkpoint: async () => {}, report: report().progress, signal: signal() });
    expect(await registration.refusal()).not.toBeNull();
    max = 3;
    expect(await registration.refusal()).toBeNull();
  });
});

describe("suspend and resume", () => {
  it("snapshots on suspend, is idempotent, and resumes from the snapshot with a fresh bootstrap", async () => {
    const t = setup();
    const { hostId } = await t.create("thr_sr");
    const suspended = await t.suspend(hostId!);
    expect(suspended).toMatchObject({ state: "suspended", sandboxId: null, snapshotId: "snap-2" });
    expect(t.fake.sandboxes.size).toBe(0);
    expect(t.sdk.kv.has(`sandbox/idle/${hostId}`)).toBe(false);
    await t.suspend(hostId!);
    expect(t.fake.calls.snapshot).toBe(1);
    expect(t.fake.calls.stop).toBe(1);
    const resumed = await t.resume(hostId!);
    expect(resumed).toMatchObject({ state: "running", sandboxId: "sb-3", snapshotId: "snap-2" });
    expect(t.sdk.state.bootstraps.map((b) => b.key)).toEqual(["thr_sr", "thr_sr"]);
    expect(t.sdk.kv.get(`sandbox/idle/${hostId}`)).toBe(t.clock.value);
    expect(await t.allocation(resumed.name)).toMatchObject({ state: "running", sandboxId: "sb-3" });
  });

  it("reuses compute that is already running instead of resuming twice", async () => {
    const t = setup();
    const { hostId } = await t.create("thr_dup");
    await t.suspend(hostId!);
    await t.resume(hostId!);
    await t.resume(hostId!);
    expect(t.fake.calls.resume).toBe(1);
  });

  it("deletes the replaced snapshot after the next resume", async () => {
    const t = setup();
    const { hostId } = await t.create("thr_snap");
    await t.suspend(hostId!);
    await t.resume(hostId!);
    const second = await t.suspend(hostId!);
    expect(second.staleSnapshotIds).toEqual(["snap-2"]);
    const resumed = await t.resume(hostId!);
    expect(resumed.staleSnapshotIds).toEqual([]);
    expect(t.fake.snapshots.has("snap-2")).toBe(false);
    expect(t.fake.snapshots.has(second.snapshotId!)).toBe(true);
  });
});

describe("idle sweep", () => {
  it("suspends a machine after idleMinutes without thread or terminal activity", async () => {
    const t = setup();
    const { hostId } = await t.create("thr_idle");
    t.clock.advance(10);
    await t.registration.sweep();
    expect(t.sdk.state.suspends).toEqual([]);
    t.clock.advance(6);
    await t.registration.sweep();
    expect(t.sdk.state.suspends).toEqual([hostId!]);
  });

  it("bumps idle on active thread events and terminal input", async () => {
    const t = setup();
    const { hostId } = await t.create("thr_busy");
    t.sdk.environments.set("env_1", hostId!);
    t.clock.advance(14);
    await t.sdk.emit("experimental_thread.events", { thread: { id: "thr_busy", status: "active", environmentId: "env_1" }, sequence: 1 });
    t.clock.advance(14);
    await t.sdk.emit("experimental_terminal.input", { terminal: { id: "term_1", hostId } });
    t.clock.advance(14);
    await t.registration.sweep();
    expect(t.sdk.state.suspends).toEqual([]);
    await t.sdk.emit("experimental_thread.events", { thread: { id: "thr_busy", status: "idle", environmentId: "env_1" }, sequence: 2 });
    t.clock.advance(2);
    await t.registration.sweep();
    expect(t.sdk.state.suspends).toEqual([hostId!]);
  });

  it("matches a provisioning thread to its machine by key", async () => {
    const t = setup();
    const { hostId } = await t.create("thr_prov");
    t.clock.advance(14);
    await t.sdk.emit("experimental_thread.events", { thread: { id: "thr_prov", status: "starting", environmentId: null }, sequence: 1 });
    t.clock.advance(14);
    await t.registration.sweep();
    expect(t.sdk.state.suspends).toEqual([]);
    expect(hostId).not.toBeNull();
  });

  it("skips busy machines quietly and never suspends when idle is disabled", async () => {
    const t = setup();
    const { hostId } = await t.create("thr_q");
    t.sdk.state.suspendFault = Object.assign(new Error("busy"), { code: "machine_busy" });
    t.clock.advance(20);
    await t.registration.sweep();
    expect(t.sdk.state.suspends).toEqual([hostId!]);
    expect(t.sdk.logs.some((line) => line.startsWith("warn") && line.includes("idle suspend"))).toBe(false);

    const off = setup({ hourlyRateUsd: 0.5, idleMinutes: null });
    await off.create("thr_off");
    off.clock.advance(600);
    await off.registration.sweep();
    expect(off.sdk.state.suspends).toEqual([]);
  });
});

describe("TTL extension", () => {
  it("extends the vendor TTL near expiry only while the machine is active", async () => {
    const t = setup();
    const { hostId, checkpoints } = await t.create("thr_ttl");
    const name = checkpoints[0]!.name;
    for (let minute = 0; minute < 104; minute += 13) {
      t.clock.advance(13);
      await t.registration.bumpIdle(hostId!);
      await t.registration.sweep();
    }
    expect(t.fake.calls.extend).toBe(0);
    t.clock.advance(4);
    await t.registration.bumpIdle(hostId!);
    await t.registration.sweep();
    expect(t.fake.calls.extend).toBe(1);
    expect((await t.allocation(name))?.expiresAt).toBe(t.clock.value + 120 * 60_000);
  });

  it("does not extend an idle machine and exposes a manual extend hook", async () => {
    const t = setup({ hourlyRateUsd: 0.5, idleMinutes: 200 });
    const { hostId } = await t.create("thr_ttl2");
    t.clock.advance(110);
    await t.registration.sweep();
    expect(t.fake.calls.extend).toBe(0);
    const expiresAt = await t.registration.extendTtl(hostId!);
    expect(expiresAt).toBe(t.clock.value + 120 * 60_000);
    expect(await t.registration.extendTtl("host_unknown")).toBeNull();
  });
});

describe("allocation sweep", () => {
  it("removes an orphaned sandbox after the grace period", async () => {
    const t = setup();
    t.sdk.state.bootstrapFault = new Error("lost");
    const { checkpoints } = await t.create("thr_orphan");
    const name = checkpoints[0]!.name;
    await t.registration.sweep();
    t.clock.advance(5);
    await t.registration.sweep();
    expect(t.fake.sandboxes.size).toBe(1);
    t.clock.advance(6);
    await t.registration.sweep();
    expect(t.fake.sandboxes.size).toBe(0);
    expect(await t.allocation(name)).toBeUndefined();
    expect(t.sdk.logs.some((line) => line.includes("removed orphaned sandbox"))).toBe(true);
    expect((await t.registration.usage()).runningMs).toBe(11 * 60_000);
  });

  it("retains orphans when policy says so", async () => {
    const t = setup({ hourlyRateUsd: 0.5, orphans: "retain" });
    t.sdk.state.bootstrapFault = new Error("lost");
    await t.create("thr_keep");
    await t.registration.sweep();
    t.clock.advance(30);
    await t.registration.sweep();
    expect(t.fake.sandboxes.size).toBe(1);
    expect(t.sdk.logs.some((line) => line.includes("retaining it for inspection"))).toBe(true);
  });

  it("asks core to reconcile a suspended machine whose compute is still running", async () => {
    const t = setup();
    const { hostId } = await t.create("thr_rec");
    t.host(hostId!).lifecycle.phase = "suspended";
    await t.registration.sweep();
    expect(t.sdk.state.reconciles).toEqual([hostId!]);
  });

  it("imports machines it has no record for and stops metering compute that vanished", async () => {
    const t = setup();
    const { hostId, checkpoints } = await t.create("thr_imp");
    const name = checkpoints[0]!.name;
    t.sdk.kv.delete(`sandbox/alloc/${name}`);
    await t.registration.sweep();
    expect(await t.allocation(name)).toMatchObject({ state: "running", hostId });
    t.fake.sandboxes.clear();
    t.clock.advance(1);
    await t.registration.sweep();
    expect(await t.allocation(name)).toMatchObject({ state: "stopped", accruedAt: null });
    expect(await t.registration.refusal()).toBeNull();
  });

  it("backs off after a vendor failure", async () => {
    const t = setup();
    await t.create("thr_bo");
    const original = t.fake.backend.listByName;
    t.fake.backend.listByName = async () => {
      throw new Error("vendor down");
    };
    await t.registration.sweep();
    const name = [...t.sdk.kv.keys()].find((k) => k.startsWith("sandbox/alloc/"))!;
    expect(t.sdk.kv.get(name)).toMatchObject({ failures: 1, nextAttemptAt: t.clock.value + 60_000 });
    t.fake.backend.listByName = original;
  });
});

describe("remove", () => {
  it("removes compute and every snapshot, then drops tracking", async () => {
    const t = setup();
    const { hostId, checkpoints } = await t.create("thr_rm");
    await t.suspend(hostId!);
    await t.resume(hostId!);
    t.clock.advance(5);
    expect(await t.remove(hostId!)).toEqual({ status: "removed" });
    expect(t.fake.sandboxes.size).toBe(0);
    expect(t.fake.snapshots.size).toBe(0);
    expect(await t.allocation(checkpoints[0]!.name)).toBeUndefined();
    expect(t.sdk.kv.has(`sandbox/idle/${hostId}`)).toBe(false);
  });

  it("fails when the vendor still lists the sandbox", async () => {
    const t = setup();
    const { hostId } = await t.create("thr_rm2");
    t.fake.faults.keepAfterRemove = true;
    const out = await t.remove(hostId!);
    expect(out.status).toBe("failed");
  });
});
