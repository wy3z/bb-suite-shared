import { describe, expect, it } from "bun:test";
import { setup } from "./sandbox-harness.ts";

describe("review blocker 1: suspend never loses its snapshot", () => {
  it("keeps compute running until the snapshot is checkpointed, so a retry recovers and nothing leaks", async () => {
    const t = setup();
    const { hostId } = await t.create("thr_snaploss");
    await expect(t.suspend(hostId!, { failCheckpoint: 1 })).rejects.toThrow("checkpoint write failed");
    expect([...t.fake.sandboxes.values()].some((sandbox) => sandbox.running)).toBe(true);
    const suspended = await t.suspend(hostId!);
    expect(suspended.state).toBe("suspended");
    expect(suspended.snapshotId).not.toBeNull();
    const resumed = await t.resume(hostId!);
    expect(resumed.state).toBe("running");
    expect(await t.remove(hostId!)).toEqual({ status: "removed" });
    expect(t.fake.snapshots.size).toBe(0);
    expect(t.fake.sandboxes.size).toBe(0);
  });

  it("refuses to report suspended when compute is gone and nothing restorable exists", async () => {
    const t = setup();
    const { hostId } = await t.create("thr_gone");
    t.fake.sandboxes.clear();
    await expect(t.suspend(hostId!)).rejects.toThrow("no saved snapshot or stopped sandbox");
  });
});

describe("review blocker 2: unknown ownership never deletes compute", () => {
  it("keeps a live machine whose resource lookup keeps failing", async () => {
    const t = setup();
    const { hostId } = await t.create("thr_owned");
    t.clock.advance(11);
    t.sdk.state.resourceFault = (id) => id === hostId;
    for (let minute = 0; minute < 30; minute += 1) {
      t.clock.advance(1);
      await t.registration.sweep();
    }
    expect(t.fake.sandboxes.size).toBe(1);
    expect(t.fake.calls.remove).toEqual([]);
  });
});

describe("review blocker 3: concurrency is enforced under parallel admissions", () => {
  it("admits one of three simultaneous creates with maxConcurrent 1", async () => {
    const t = setup({ hourlyRateUsd: 0.5, maxConcurrent: 1 });
    t.fake.faults.createDelay = 5;
    const results = await Promise.all([t.create("thr_p1"), t.create("thr_p2"), t.create("thr_p3")]);
    expect(results.filter((r) => r.result.status === "created")).toHaveLength(1);
    expect(results.filter((r) => r.result.status === "failed" && r.result.message.includes("max concurrent 1"))).toHaveLength(2);
    expect(t.fake.sandboxes.size).toBe(1);
  });

  it("admits one of two simultaneous resumes, and one of a mixed resume and create", async () => {
    let max = 2;
    const t = setup(() => ({ hourlyRateUsd: 0.5, maxConcurrent: max }));
    const a = await t.create("thr_r1");
    const b = await t.create("thr_r2");
    await t.suspend(a.hostId!);
    await t.suspend(b.hostId!);
    max = 1;
    t.fake.faults.createDelay = 5;
    const resumes = await Promise.allSettled([t.resume(a.hostId!), t.resume(b.hostId!)]);
    expect(resumes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect([...t.fake.sandboxes.values()].filter((s) => s.running)).toHaveLength(1);
    const winner = resumes[0]!.status === "fulfilled" ? a : b;
    const loser = winner === a ? b : a;
    await t.suspend(winner.hostId!);
    const [resumed, created] = await Promise.allSettled([t.resume(loser.hostId!), t.create("thr_r3")]);
    const succeeded = (resumed.status === "fulfilled" ? 1 : 0) + (created.status === "fulfilled" && created.value.result.status === "created" ? 1 : 0);
    expect(succeeded).toBe(1);
    expect([...t.fake.sandboxes.values()].filter((s) => s.running)).toHaveLength(1);
  });
});

describe("review blocker 4: suspend stops every allocation under the name", () => {
  it("stops duplicate compute and verifies nothing is still running", async () => {
    const t = setup();
    const { hostId, checkpoints } = await t.create("thr_dupes");
    const name = checkpoints[0]!.name;
    t.fake.sandboxes.set("sb-dup", { id: "sb-dup", name, running: true, expiresAt: null, snapshotId: null });
    const suspended = await t.suspend(hostId!);
    expect(suspended.state).toBe("suspended");
    expect([...t.fake.sandboxes.values()].filter((s) => s.name === name && s.running)).toHaveLength(0);
  });

  it("fails rather than reporting suspended when a duplicate cannot be stopped", async () => {
    const t = setup();
    const { hostId, checkpoints } = await t.create("thr_stuckdup");
    const name = checkpoints[0]!.name;
    t.fake.sandboxes.set("sb-dup", { id: "sb-dup", name, running: true, expiresAt: null, snapshotId: null });
    t.fake.faults.keepAfterRemove = true;
    await expect(t.suspend(hostId!)).rejects.toThrow("still running after suspend");
  });
});

describe("review blocker 5: vendor progress is redacted", () => {
  it("redacts what the vendor reports during create and suspend", async () => {
    const t = setup();
    t.fake.faults.progress = "connecting with password=hunter2-very-secret and Bearer abcdefghijklmnopqrstuvwxyz";
    const { lines, hostId } = await t.create("thr_leak");
    const suspendLines: string[] = [];
    await t.suspend(hostId!, { lines: suspendLines });
    const all = [...lines, ...suspendLines].join("\n");
    expect(all).toContain("[redacted]");
    expect(all).not.toContain("hunter2");
    expect(all).not.toContain("abcdefghijklmnop");
  });

  it("redacts vendor availability and validate messages", async () => {
    const t = setup();
    t.fake.backend.availability = () => ({ status: "setup-required", message: "bad key sk-ant-api03-abcdefghijklmnop" });
    t.fake.backend.validate = () => ({ action: "refuse", message: "token=supersecretvalue rejected" });
    const availability = await t.sdk.machine.availability!();
    const decision = await t.sdk.machine.validate!({ inputs: null as never });
    expect(JSON.stringify([availability, decision])).not.toMatch(/abcdefghijklmnop|supersecretvalue/);
  });
});

describe("review blocker 6: TTL renewal stops at the monthly cap", () => {
  it("does not renew past the cap and asks core to suspend instead", async () => {
    const t = setup({ hourlyRateUsd: 1, monthlyCapUsd: 0.01, idleMinutes: null, ttlMinutes: 10, maxConcurrent: null });
    const { hostId } = await t.create("thr_cap");
    t.clock.advance(1);
    await t.registration.bumpIdle(hostId!);
    expect(await t.registration.refusal()).toContain("monthly cap");
    await t.registration.sweep();
    expect(t.fake.calls.extend).toBe(0);
    expect(t.sdk.state.suspends).toEqual([hostId!]);
    await expect(t.registration.extendTtl(hostId!)).rejects.toThrow("monthly cap");
    expect(t.fake.calls.extend).toBe(0);
  });

  it("still renews while under the cap", async () => {
    const t = setup({ hourlyRateUsd: 1, monthlyCapUsd: 100, idleMinutes: null, ttlMinutes: 10, maxConcurrent: null });
    const { hostId } = await t.create("thr_under");
    t.clock.advance(1);
    await t.registration.bumpIdle(hostId!);
    await t.registration.sweep();
    expect(t.fake.calls.extend).toBe(1);
    expect(t.sdk.state.suspends).toEqual([]);
  });
});
