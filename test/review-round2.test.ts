import { describe, expect, it } from "bun:test";
import { registerSandboxBackend, sandboxNameForKey } from "../src/machine-backend-server.ts";
import { setup } from "./sandbox-harness.ts";

const running = (t: ReturnType<typeof setup>) => [...t.fake.sandboxes.values()].filter((sandbox) => sandbox.running);

describe("round 2 blocker 1: uncertain creates keep their concurrency slot", () => {
  it("counts compute allocated by a create whose response was lost", async () => {
    const t = setup({ hourlyRateUsd: 0.5, maxConcurrent: 1 });
    t.fake.faults.createLoseResponse = true;
    const first = await t.create("thr_lost");
    expect(first.result).toEqual({ status: "failed", message: "socket hang up after allocation" });
    const second = await t.create("thr_next");
    expect(second.result.status).toBe("failed");
    if (second.result.status === "failed") expect(second.result.message).toContain("max concurrent 1");
    expect(running(t)).toHaveLength(1);
    expect(await t.allocation(sandboxNameForKey("thr_lost"))).toMatchObject({ state: "running", sandboxId: "sb-1" });
  });

  it("keeps an unresolved reservation from before a restart until the vendor proves absence", async () => {
    const t = setup({ hourlyRateUsd: 0.5, maxConcurrent: 1 });
    const name = sandboxNameForKey("thr_restart");
    t.sdk.kv.set(`sandbox/alloc/${name}`, {
      key: "thr_restart",
      name,
      state: "allocating",
      hostId: null,
      sandboxId: null,
      snapshotIds: [],
      createdAt: t.clock.value,
      accruedAt: null,
      expiresAt: null,
      failures: 0,
      nextAttemptAt: 0,
    });
    t.fake.sandboxes.set("sb-orphan", { id: "sb-orphan", name, running: true, expiresAt: null, snapshotId: null });
    expect((await t.create("thr_after")).result.status).toBe("failed");
    await t.registration.sweep();
    expect(await t.allocation(name)).toMatchObject({ state: "running", sandboxId: "sb-orphan" });
    expect((await t.create("thr_after2")).result.status).toBe("failed");
    t.fake.sandboxes.clear();
    await t.registration.sweep();
    expect(await t.allocation(name)).toMatchObject({ state: "stopped" });
    expect((await t.create("thr_after3")).result.status).toBe("created");
  });
});

describe("round 2 blocker 2: snapshot ledger survives sweeps and lost responses", () => {
  it("keeps a snapshot saved before a failed checkpoint through a sweep, and deletes it in the end", async () => {
    const t = setup();
    const { hostId } = await t.create("thr_ledger");
    await expect(t.suspend(hostId!, { failCheckpoint: 1 })).rejects.toThrow("checkpoint write failed");
    await t.registration.sweep();
    await t.suspend(hostId!);
    await t.resume(hostId!);
    expect(await t.remove(hostId!)).toEqual({ status: "removed" });
    expect(t.fake.sandboxes.size).toBe(0);
    expect(t.fake.snapshots.size).toBe(0);
  });

  it("recovers a snapshot whose response was lost, across a sweep and a restart", async () => {
    const t = setup();
    const { hostId } = await t.create("thr_lostsnap");
    t.fake.faults.snapshotLoseResponse = true;
    await expect(t.suspend(hostId!)).rejects.toThrow("timeout waiting for snapshot response");
    expect(t.fake.snapshots.size).toBe(1);
    await t.registration.sweep();
    registerSandboxBackend(t.sdk.bb, t.fake.backend, { hourlyRateUsd: 0.5 }, { now: t.clock.now, launchCheck: false });
    expect(await t.remove(hostId!)).toEqual({ status: "removed" });
    expect(t.fake.snapshots.size).toBe(0);
  });

  it("marks a recovered snapshot stale when the retry saves a newer one", async () => {
    const t = setup();
    const { hostId } = await t.create("thr_retrysnap");
    t.fake.faults.snapshotLoseResponse = true;
    await expect(t.suspend(hostId!)).rejects.toThrow("timeout");
    const suspended = await t.suspend(hostId!);
    expect(suspended.staleSnapshotIds).toEqual(["snap-2"]);
    await t.resume(hostId!);
    expect(t.fake.snapshots.has("snap-2")).toBe(false);
    expect(t.fake.snapshots.has(suspended.snapshotId!)).toBe(true);
  });
});

describe("round 2 blocker 3: a snapshot only restores the compute it was taken from", () => {
  it("refuses to report suspended when resumed compute vanishes before its own snapshot", async () => {
    const t = setup();
    const { hostId } = await t.create("thr_gen");
    await t.suspend(hostId!);
    await t.resume(hostId!);
    t.fake.sandboxes.clear();
    await expect(t.suspend(hostId!)).rejects.toThrow("taken from earlier compute");
  });

  it("accepts the snapshot when compute stopped after it was checkpointed", async () => {
    const t = setup();
    const { hostId } = await t.create("thr_gen2");
    await t.suspend(hostId!);
    await t.resume(hostId!);
    await expect(t.suspend(hostId!, { failCheckpoint: 2 })).rejects.toThrow("checkpoint write failed");
    const suspended = await t.suspend(hostId!);
    expect(suspended.state).toBe("suspended");
    expect((await t.resume(hostId!)).state).toBe("running");
  });
});
