import { describe, expect, it } from "bun:test";
import { readSandboxResource } from "../src/machine-backend-server.ts";
import { setup } from "./sandbox-harness.ts";

function barrier() {
  let reached!: () => void;
  let release!: () => void;
  const reachedP = new Promise<void>((resolve) => (reached = resolve));
  const releaseP = new Promise<void>((resolve) => (release = resolve));
  return { gate: { reached, release: releaseP }, reachedP, release };
}

function withoutFindSnapshot(t: ReturnType<typeof setup>) {
  delete (t.fake.backend as { findSnapshot?: unknown }).findSnapshot;
}

describe("round 3 blocker 1: overlapping sweeps and lifecycle writes never erase the snapshot ledger", () => {
  it("runs overlapping sweeps as one flight", async () => {
    const t = setup();
    await t.create("thr_single");
    let lists = 0;
    const original = t.fake.backend.listByName;
    t.fake.backend.listByName = async (name, signal) => {
      lists += 1;
      return original(name, signal);
    };
    const b = barrier();
    t.fake.faults.pauseList = b.gate;
    const first = t.registration.sweep();
    await b.reachedP;
    const second = t.registration.sweep();
    expect(second).toBe(first);
    b.release();
    await Promise.all([first, second]);
    expect(lists).toBe(1);
    const third = t.registration.sweep();
    expect(third).not.toBe(first);
    await third;
  });

  it("keeps a snapshot saved during a paused sweep after a failed checkpoint", async () => {
    const t = setup();
    const { hostId } = await t.create("thr_overlap1");
    const b = barrier();
    t.fake.faults.pauseList = b.gate;
    const sweeping = t.registration.sweep();
    await b.reachedP;
    await expect(t.suspend(hostId!, { failCheckpoint: 1 })).rejects.toThrow("checkpoint write failed");
    b.release();
    await sweeping;
    await t.suspend(hostId!);
    await t.resume(hostId!);
    expect(await t.remove(hostId!)).toEqual({ status: "removed" });
    expect(t.fake.sandboxes.size).toBe(0);
    expect(t.fake.snapshots.size).toBe(0);
  });

  it("keeps a pending snapshot operation recorded during a paused sweep", async () => {
    const t = setup();
    const { hostId } = await t.create("thr_overlap2");
    const b = barrier();
    t.fake.faults.pauseList = b.gate;
    const sweeping = t.registration.sweep();
    await b.reachedP;
    t.fake.faults.snapshotLoseResponse = true;
    await expect(t.suspend(hostId!)).rejects.toThrow("timeout waiting for snapshot response");
    b.release();
    await sweeping;
    expect(t.fake.snapshots.size).toBe(1);
    expect(await t.remove(hostId!)).toEqual({ status: "removed" });
    expect(t.fake.snapshots.size).toBe(0);
  });
});

describe("round 3 blocker 2: snapshot recovery with and without findSnapshot", () => {
  it("with findSnapshot, recovers a lost snapshot by key and records nothing unverified", async () => {
    const t = setup();
    const { hostId } = await t.create("thr_keyed");
    t.fake.faults.snapshotLoseResponse = true;
    await expect(t.suspend(hostId!)).rejects.toThrow("timeout");
    const suspended = await t.suspend(hostId!);
    expect(suspended.unverifiedSnapshotOps).toEqual([]);
    expect(await t.registration.unverifiedSnapshots()).toEqual([]);
    await t.remove(hostId!);
    expect(t.fake.snapshots.size).toBe(0);
  });

  it("without findSnapshot, keeps compute running, retries, and records the possible orphan as unverified", async () => {
    const t = setup();
    withoutFindSnapshot(t);
    const { hostId, checkpoints } = await t.create("thr_fallback");
    const name = checkpoints[0]!.name;
    t.fake.faults.snapshotLoseCount = 1;
    const lines: string[] = [];
    const stopsBefore = t.fake.calls.stop;
    const suspended = await t.suspend(hostId!, { lines });
    expect(t.fake.calls.snapshot).toBe(2);
    expect(t.fake.calls.stop).toBe(stopsBefore + 1);
    expect(suspended.state).toBe("suspended");
    expect(suspended.snapshotId).toBe("snap-3");
    expect(suspended.unverifiedSnapshotOps).toHaveLength(1);
    expect(lines.some((line) => line.includes("may exist that BB is not tracking") && line.includes(suspended.unverifiedSnapshotOps[0]!))).toBe(true);
    expect(lines.some((line) => line.includes("Retrying the Fake Sandbox snapshot"))).toBe(true);
    expect((await t.registration.unverifiedSnapshots()).map((entry) => [entry.name, entry.operationKey])).toEqual([
      [name, suspended.unverifiedSnapshotOps[0]!],
    ]);
    expect(t.fake.snapshots.has("snap-2")).toBe(true);
  });

  it("without findSnapshot, never stops compute when every snapshot response is lost, and keeps the record through removal", async () => {
    const t = setup();
    withoutFindSnapshot(t);
    const { hostId } = await t.create("thr_fallback2");
    t.fake.faults.snapshotLoseCount = 2;
    await expect(t.suspend(hostId!)).rejects.toThrow("timeout");
    expect(t.fake.calls.stop).toBe(0);
    expect([...t.fake.sandboxes.values()].every((sandbox) => sandbox.running)).toBe(true);
    const resource = readSandboxResource(t.sdk.resources.get(hostId!));
    expect(resource.state).toBe("running");
    expect(resource.unverifiedSnapshotOps).toHaveLength(2);
    expect(await t.remove(hostId!)).toEqual({ status: "removed" });
    expect(t.fake.sandboxes.size).toBe(0);
    const recorded = await t.registration.unverifiedSnapshots();
    expect(recorded.map((entry) => entry.operationKey).sort()).toEqual([...resource.unverifiedSnapshotOps].sort());
    await t.registration.forgetUnverifiedSnapshot(recorded[0]!.operationKey);
    expect(await t.registration.unverifiedSnapshots()).toHaveLength(1);
  });

  it("without findSnapshot, an interrupted snapshot left pending is surfaced as unverified on removal", async () => {
    const t = setup();
    withoutFindSnapshot(t);
    const { hostId, checkpoints } = await t.create("thr_pending");
    const name = checkpoints[0]!.name;
    const record = t.sdk.kv.get(`sandbox/alloc/${name}`) as Record<string, unknown>;
    t.sdk.kv.set(`sandbox/alloc/${name}`, { ...record, pendingSnapshotOps: ["op-crashed"] });
    expect(await t.remove(hostId!)).toEqual({ status: "removed" });
    expect((await t.registration.unverifiedSnapshots()).map((entry) => entry.operationKey)).toEqual(["op-crashed"]);
  });
});
