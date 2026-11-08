import type {
  BbPluginApi,
  JsonValue,
  MachineExecutor,
  MachineExecutorRequest,
  PluginBbSdk,
  PluginKvStorage,
  PluginMachineProviderDeclaration,
  PluginMachineValidateDecision,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  COMPOSED_ENVIRONMENT_PROVIDER,
  SANDBOX_RESOURCE_VERSION,
  concurrencyRefusal,
  findSecretLike,
  missingRateMessage,
  monthlyCapRefusal,
  readSandboxResource,
  redactSecrets,
  resolveSandboxPolicy,
  usageMonth,
  type SandboxInitKind,
  type SandboxPolicy,
  type SandboxPolicyInput,
  type SandboxResource,
  type SandboxUsage,
} from "./machine-backend";
import { createCloudLaunchCheck, type CloudLaunchCheckOptions } from "./cloud-launch-server";

export * from "./machine-backend";
export * from "./cloud-launch-server";

export type SandboxInputsSchema = PluginMachineProviderDeclaration["inputs"];
type Declaration<S extends SandboxInputsSchema> = PluginMachineProviderDeclaration<S>;
type CreateContext<S extends SandboxInputsSchema> = Parameters<Declaration<S>["create"]>[0];
export type SandboxInputs<S extends SandboxInputsSchema> = CreateContext<S>["inputs"];
export type SandboxProgress = CreateContext<undefined>["report"];
export type SandboxAvailability = Awaited<ReturnType<NonNullable<Declaration<undefined>["availability"]>>>;
type ProviderResource = Parameters<CreateContext<undefined>["checkpoint"]>[0];
type Host = Awaited<ReturnType<PluginBbSdk["hosts"]["list"]>>[number];

export interface SandboxHandle {
  id: string;
  running: boolean;
  expiresAt: number | null;
  meta?: Record<string, JsonValue>;
}

export interface SandboxBackend<S extends SandboxInputsSchema = undefined> {
  id: string;
  displayName: string;
  description: string;
  environmentDescription?: string;
  icon: string;
  ephemeral?: boolean;
  inputs?: S;
  nameFor?(key: string): string;
  availability?(): SandboxAvailability | Promise<SandboxAvailability>;
  validate?(inputs: SandboxInputs<S>): PluginMachineValidateDecision | Promise<PluginMachineValidateDecision>;
  create(request: {
    key: string;
    name: string;
    inputs: SandboxInputs<S>;
    ttlMs: number;
    signal: AbortSignal;
    report: SandboxProgress;
  }): Promise<SandboxHandle>;
  exec(sandboxId: string, request: MachineExecutorRequest): Promise<{ exitCode: number }>;
  snapshot(request: {
    sandboxId: string;
    name: string;
    operationKey: string;
    signal: AbortSignal;
    report: SandboxProgress;
  }): Promise<{ snapshotId: string | null }>;
  findSnapshot(request: { name: string; operationKey: string; signal: AbortSignal }): Promise<string | null>;
  stop(request: {
    sandboxId: string;
    name: string;
    signal: AbortSignal;
    report: SandboxProgress;
  }): Promise<{ sandboxId: string | null }>;
  resume(request: {
    name: string;
    sandboxId: string | null;
    snapshotId: string | null;
    meta: Record<string, JsonValue>;
    ttlMs: number;
    signal: AbortSignal;
    report: SandboxProgress;
  }): Promise<SandboxHandle>;
  remove(request: {
    name: string;
    sandboxIds: string[];
    snapshotIds: string[];
    signal: AbortSignal;
    report: SandboxProgress;
  }): Promise<void>;
  listByName(name: string, signal: AbortSignal): Promise<SandboxHandle[]>;
  extendTtl?(request: {
    sandboxId: string;
    name: string;
    ttlMs: number;
    signal: AbortSignal;
  }): Promise<{ expiresAt: number | null }>;
}

export interface SandboxPluginApi {
  readonly log: BbPluginApi["log"];
  readonly storage: { readonly kv: PluginKvStorage };
  readonly background: Pick<BbPluginApi["background"], "schedule">;
  readonly events: BbPluginApi["events"];
  readonly experimental_hooks: Pick<BbPluginApi["experimental_hooks"], "on">;
  readonly experimental_machines: Pick<BbPluginApi["experimental_machines"], "register" | "bootstrap" | "getResource">;
  readonly experimental_environments: Pick<BbPluginApi["experimental_environments"], "register">;
  readonly sdk: {
    readonly hosts: Pick<PluginBbSdk["hosts"], "list" | "get" | "experimental_suspend" | "experimental_reconcile">;
    readonly environments: Pick<PluginBbSdk["environments"], "get">;
    readonly projects: Pick<PluginBbSdk["projects"], "machineEnvironment">;
    readonly plugins: Pick<PluginBbSdk["plugins"], "callRpc">;
  };
}

export type SandboxPolicySource = SandboxPolicyInput | (() => SandboxPolicyInput | Promise<SandboxPolicyInput>);

export interface SandboxRegistrationOptions {
  now?: () => number;
  scheduleName?: string;
  vendorTimeoutMs?: number;
  launchCheck?: CloudLaunchCheckOptions | false;
}

export interface SandboxBackendRegistration {
  sweep(): Promise<void>;
  bumpIdle(hostId: string): Promise<void>;
  extendTtl(hostId: string): Promise<number | null>;
  usage(): Promise<SandboxUsage>;
  refusal(): Promise<string | null>;
}

const ALLOCATION_STATES = ["allocating", "resuming", "running", "suspended", "stopped"] as const;
const allocationSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  state: z.enum(ALLOCATION_STATES),
  hostId: z.string().nullable(),
  sandboxId: z.string().nullable(),
  snapshotIds: z.array(z.string()),
  createdAt: z.number(),
  accruedAt: z.number().nullable(),
  expiresAt: z.number().nullable(),
  failures: z.number().int().nonnegative(),
  nextAttemptAt: z.number(),
  unownedSince: z.number().nullable().default(null),
  pendingSnapshotOps: z.array(z.string()).default([]),
});
type Allocation = z.output<typeof allocationSchema>;

const ALLOCATION_PREFIX = "sandbox/alloc/";
const IDLE_PREFIX = "sandbox/idle/";
const USAGE_PREFIX = "sandbox/usage/";
const MINUTE = 60_000;
const INIT_PROBE = ["sh", "-c", "if [ -d /run/systemd/system ]; then echo systemd; else echo none; fi"];
const NO_SYSTEMD_NOTE =
  "No systemd in this sandbox image: the BB daemon runs as a temporary join process, so every resume re-runs bootstrap to restart it.";

function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function sandboxNameForKey(key: string, prefix = "bb"): string {
  const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length > 0 && slug.length <= 40 && slug === key) return `${prefix}-${slug}`;
  const digest = `${fnv1a(key, 0x811c9dc5)}${fnv1a(key, 0x01000193)}`;
  return `${prefix}-${slug.slice(0, 24).replace(/-+$/g, "")}${slug.length > 0 ? "-" : ""}${digest}`;
}

function errorText(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === code;
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function asResource(resource: SandboxResource): ProviderResource {
  return resource as unknown as ProviderResource;
}

function redactingReport(report: SandboxProgress): SandboxProgress {
  return {
    step: (text) => report.step(redactSecrets(text)),
    log: (text) => report.log(redactSecrets(text)),
  };
}

function redactDecision<T extends { message: string } | { status: "available" } | { action: "accept" }>(value: T): T {
  return "message" in value ? { ...value, message: redactSecrets(value.message) } : value;
}

type Owned = Map<string, { host: Host; resource: SandboxResource }>;

export function registerSandboxBackend<S extends SandboxInputsSchema = undefined>(
  bb: SandboxPluginApi,
  backend: SandboxBackend<S>,
  policy: SandboxPolicySource,
  options: SandboxRegistrationOptions = {},
): SandboxBackendRegistration {
  const now = options.now ?? Date.now;
  const vendorTimeoutMs = options.vendorTimeoutMs ?? MINUTE;
  const kv = bb.storage.kv;
  const label = backend.displayName;
  const inFlight = new Set<string>();
  let admissionChain: Promise<unknown> = Promise.resolve();
  const nameFor = (key: string) => backend.nameFor?.(key) ?? sandboxNameForKey(key);
  const logReport: SandboxProgress = {
    step: (text) => bb.log.info(redactSecrets(text)),
    log: (text) => bb.log.info(redactSecrets(text)),
  };

  async function readPolicy(): Promise<SandboxPolicy> {
    return resolveSandboxPolicy(typeof policy === "function" ? await policy() : policy);
  }

  function freshAllocation(key: string, name: string, at: number): Allocation {
    return {
      key,
      name,
      state: "allocating",
      hostId: null,
      sandboxId: null,
      snapshotIds: [],
      createdAt: at,
      accruedAt: null,
      expiresAt: null,
      failures: 0,
      nextAttemptAt: 0,
      unownedSince: null,
      pendingSnapshotOps: [],
    };
  }

  async function readAllocation(name: string): Promise<Allocation | null> {
    const value = await kv.get(`${ALLOCATION_PREFIX}${name}`);
    return value === undefined ? null : allocationSchema.parse(value);
  }

  async function writeAllocation(allocation: Allocation): Promise<void> {
    await kv.set(`${ALLOCATION_PREFIX}${allocation.name}`, allocation);
  }

  async function listAllocations(): Promise<Allocation[]> {
    const out: Allocation[] = [];
    for (const key of await kv.list(ALLOCATION_PREFIX)) {
      const parsed = allocationSchema.safeParse(await kv.get(key));
      if (parsed.success) out.push(parsed.data);
      else bb.log.warn(`${label}: ignoring unreadable allocation record ${key}`);
    }
    return out;
  }

  async function readUsageMs(month: string): Promise<number> {
    const value = await kv.get(`${USAGE_PREFIX}${month}`);
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  async function accrue(allocation: Allocation, at: number): Promise<Allocation> {
    if (allocation.accruedAt === null) return allocation;
    const delta = Math.max(0, at - allocation.accruedAt);
    if (delta > 0) {
      const month = usageMonth(at);
      await kv.set(`${USAGE_PREFIX}${month}`, (await readUsageMs(month)) + delta);
    }
    return { ...allocation, accruedAt: at };
  }

  async function patchAllocation(
    key: string,
    name: string,
    patch: (current: Allocation, at: number) => Partial<Allocation>,
  ): Promise<Allocation> {
    const at = now();
    const current = await accrue((await readAllocation(name)) ?? freshAllocation(key, name, at), at);
    const next = { ...current, ...patch(current, at) };
    await writeAllocation(next);
    return next;
  }

  async function dropAllocation(name: string): Promise<void> {
    const current = await readAllocation(name);
    if (current !== null) await accrue(current, now());
    await kv.delete(`${ALLOCATION_PREFIX}${name}`);
  }

  async function usage(): Promise<SandboxUsage> {
    const current = await readPolicy();
    const at = now();
    const month = usageMonth(at);
    let runningMs = await readUsageMs(month);
    for (const allocation of await listAllocations()) {
      if (allocation.accruedAt !== null) runningMs += Math.max(0, at - allocation.accruedAt);
    }
    return {
      month,
      runningMs,
      estimatedUsd: current.hourlyRateUsd === null ? null : (runningMs / (60 * MINUTE)) * current.hourlyRateUsd,
      capUsd: current.monthlyCapUsd,
    };
  }

  async function spendRefusal(current: SandboxPolicy): Promise<string | null> {
    if (current.monthlyCapUsd !== null && current.hourlyRateUsd === null) {
      return missingRateMessage(label, current.monthlyCapUsd);
    }
    return monthlyCapRefusal(label, await usage());
  }

  function holdsSlot(allocation: Allocation): boolean {
    return allocation.state === "running" || allocation.state === "allocating" || allocation.state === "resuming";
  }

  async function refusalFor(excludeName: string | null): Promise<string | null> {
    const current = await readPolicy();
    const spend = await spendRefusal(current);
    if (spend !== null) return spend;
    const running = (await listAllocations()).filter(
      (allocation) => allocation.name !== excludeName && holdsSlot(allocation),
    ).length;
    return concurrencyRefusal(label, running, current.maxConcurrent);
  }

  function admit<T>(run: () => Promise<T>): Promise<T> {
    const next = admissionChain.then(run, run);
    admissionChain = next.catch(() => undefined);
    return next;
  }

  async function reserve(
    key: string,
    name: string,
    state: "allocating" | "resuming",
  ): Promise<string | null> {
    return admit(async () => {
      const refusal = await refusalFor(name);
      if (refusal !== null) return refusal;
      await patchAllocation(key, name, (allocation) => ({
        state: allocation.state === "running" ? "running" : state,
      }));
      return null;
    });
  }

  async function bumpIdle(hostId: string): Promise<void> {
    await kv.set(`${IDLE_PREFIX}${hostId}`, now());
  }

  async function readIdle(hostId: string): Promise<number | null> {
    const value = await kv.get(`${IDLE_PREFIX}${hostId}`);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  async function bumpOwned(hostId: string): Promise<void> {
    const host = await bb.sdk.hosts.get({ hostId });
    if (host.machineProviderId === backend.id && host.lifecycle.phase === "active") await bumpIdle(hostId);
  }

  async function owners(): Promise<{ owned: Owned; complete: boolean }> {
    const owned: Owned = new Map();
    let complete = true;
    for (const host of await bb.sdk.hosts.list()) {
      if (host.machineProviderId !== backend.id || host.lifecycle.phase === "destroyed") continue;
      try {
        const value = await bb.experimental_machines.getResource(host.id);
        if (value === null) continue;
        const resource = readSandboxResource(value);
        owned.set(resource.key, { host, resource });
      } catch (error) {
        complete = false;
        bb.log.warn(`${label}: resource lookup failed for ${host.id}: ${errorText(error)}`);
      }
    }
    return { owned, complete };
  }

  function executorFor(sandboxId: string): MachineExecutor {
    return { exec: (request) => backend.exec(sandboxId, request) };
  }

  async function bootstrap(key: string, sandboxId: string, report: SandboxProgress, signal: AbortSignal) {
    const started = now();
    const result = await bb.experimental_machines.bootstrap({ key, executor: executorFor(sandboxId), report, signal });
    report.log(`${label} daemon connected in ${now() - started} ms`);
    return result;
  }

  async function probeInit(sandboxId: string, report: SandboxProgress, signal: AbortSignal): Promise<SandboxInitKind> {
    let output = "";
    try {
      const { exitCode } = await backend.exec(sandboxId, {
        command: INIT_PROBE,
        timeoutMs: 15_000,
        signal,
        stdin: "",
        onOutput: (chunk) => {
          output += chunk;
        },
      });
      if (exitCode !== 0) return "unknown";
    } catch {
      signal.throwIfAborted();
      return "unknown";
    }
    const init = output.trim().split(/\s+/).pop();
    if (init === "none") report.log(NO_SYSTEMD_NOTE);
    return init === "systemd" || init === "none" ? init : "unknown";
  }

  function assertSecretFree(value: unknown, what: string): void {
    const found = findSecretLike(value);
    if (found !== null) {
      throw new Error(
        `${label}: ${what} holds a credential-like value at ${found}. Keep secrets in plugin secret settings or Machine environment, never in inputs or resources.`,
      );
    }
  }

  function machineName(hostId: string): string {
    return `${label} ${hostId.replace(/[^a-z0-9]/gi, "").slice(-6)}`;
  }

  async function extendAllocation(allocation: Allocation, current: SandboxPolicy): Promise<number | null> {
    if (!backend.extendTtl || allocation.sandboxId === null || allocation.state !== "running") return null;
    const spend = await spendRefusal(current);
    if (spend !== null) throw new Error(spend);
    const { expiresAt } = await backend.extendTtl({
      sandboxId: allocation.sandboxId,
      name: allocation.name,
      ttlMs: current.ttlMinutes * MINUTE,
      signal: AbortSignal.timeout(vendorTimeoutMs),
    });
    await patchAllocation(allocation.key, allocation.name, () => ({ expiresAt }));
    bb.log.info(`${label}: extended ${allocation.name} until ${expiresAt === null ? "no expiry" : new Date(expiresAt).toISOString()}`);
    return expiresAt;
  }

  async function requestSuspend(host: Host, why: string): Promise<void> {
    try {
      await bb.sdk.hosts.experimental_suspend({ hostId: host.id });
    } catch (error) {
      if (hasErrorCode(error, "machine_busy")) return;
      const fresh = await bb.sdk.hosts.get({ hostId: host.id }).catch(() => null);
      const phase = fresh?.lifecycle.phase;
      if (phase === "suspending" || phase === "suspended" || phase === "resuming") return;
      bb.log.warn(`${label}: ${why} suspend failed for ${host.id}: ${errorText(error)}`);
    }
  }

  async function importAllocations(owned: Owned, at: number) {
    for (const { host, resource } of owned.values()) {
      if (inFlight.has(resource.name) || (await readAllocation(resource.name)) !== null) continue;
      const running = host.lifecycle.phase === "active" && resource.state === "running";
      await writeAllocation({
        ...freshAllocation(resource.key, resource.name, at),
        state: running ? "running" : resource.state === "allocating" ? "allocating" : "suspended",
        hostId: host.id,
        sandboxId: resource.sandboxId,
        snapshotIds: unique([resource.snapshotId, ...resource.staleSnapshotIds]),
        accruedAt: running ? at : null,
      });
    }
  }

  async function sweepAllocations(owned: Owned, complete: boolean, current: SandboxPolicy, at: number) {
    const graceMs = current.orphanGraceMinutes * MINUTE;
    for (const stored of await listAllocations()) {
      if (inFlight.has(stored.name) || stored.nextAttemptAt > at) continue;
      let allocation = await accrue(stored, at);
      try {
        const signal = AbortSignal.timeout(vendorTimeoutMs);
        const live = await backend.listByName(allocation.name, signal);
        const running = live.filter((handle) => handle.running);
        if (allocation.state === "allocating" || allocation.state === "resuming" || allocation.state === "running") {
          const found = running.find((handle) => handle.id === allocation.sandboxId) ?? running[0] ?? null;
          allocation =
            found !== null
              ? {
                  ...allocation,
                  state: "running",
                  sandboxId: found.id,
                  accruedAt: allocation.accruedAt ?? at,
                  expiresAt: found.expiresAt ?? allocation.expiresAt,
                }
              : { ...allocation, state: allocation.state === "resuming" ? "suspended" : "stopped", accruedAt: null };
        }
        const owner = owned.get(allocation.key) ?? null;
        if (owner === null) {
          if (!complete) {
            await writeAllocation(allocation);
            continue;
          }
          allocation = { ...allocation, unownedSince: allocation.unownedSince ?? at };
          if (at - allocation.unownedSince! < graceMs) {
            await writeAllocation(allocation);
            continue;
          }
          const fresh = await owners();
          if (!fresh.complete || fresh.owned.has(allocation.key) || inFlight.has(allocation.name)) {
            await writeAllocation({ ...allocation, unownedSince: fresh.owned.has(allocation.key) ? null : allocation.unownedSince });
            continue;
          }
          await writeAllocation(allocation);
          allocation = (await resolvePendingSnapshots(allocation.key, allocation.name, signal)) ?? allocation;
          if (live.length === 0 && allocation.snapshotIds.length === 0) {
            await kv.delete(`${ALLOCATION_PREFIX}${allocation.name}`);
            continue;
          }
          if (current.orphans === "retain") {
            bb.log.warn(`${label}: ${allocation.name} has no machine; retaining it for inspection`);
            await writeAllocation({ ...allocation, failures: 0, nextAttemptAt: 0 });
            continue;
          }
          await backend.remove({
            name: allocation.name,
            sandboxIds: live.map((handle) => handle.id),
            snapshotIds: allocation.snapshotIds,
            signal,
            report: logReport,
          });
          if ((await backend.listByName(allocation.name, signal)).length > 0) {
            throw new Error(`${allocation.name} is still present after orphan cleanup`);
          }
          await kv.delete(`${ALLOCATION_PREFIX}${allocation.name}`);
          bb.log.warn(`${label}: removed orphaned sandbox ${allocation.name} (no machine owns it)`);
          continue;
        }
        if (owner.host.lifecycle.phase === "suspended" && running.length > 0) {
          await bb.sdk.hosts.experimental_reconcile({ hostId: owner.host.id });
        }
        const head = running.find((handle) => handle.id === owner.resource.sandboxId) ?? running[0] ?? null;
        const suspended = owner.host.lifecycle.phase === "suspended" || allocation.state === "suspended";
        allocation = {
          ...allocation,
          hostId: owner.host.id,
          unownedSince: null,
          state: head !== null ? "running" : suspended ? "suspended" : "stopped",
          sandboxId: head?.id ?? allocation.sandboxId,
          snapshotIds: unique([...allocation.snapshotIds, owner.resource.snapshotId, ...owner.resource.staleSnapshotIds]),
          accruedAt: head !== null ? (allocation.accruedAt ?? at) : null,
          expiresAt: head !== null ? (head.expiresAt ?? allocation.expiresAt) : allocation.expiresAt,
          failures: 0,
          nextAttemptAt: 0,
        };
        await writeAllocation(allocation);
      } catch (error) {
        const failures = Math.min(allocation.failures + 1, 7);
        await writeAllocation({
          ...allocation,
          failures,
          nextAttemptAt: at + Math.min(60 * MINUTE, MINUTE * 2 ** Math.min(allocation.failures, 6)),
        });
        bb.log.warn(`${label}: allocation sweep failed for ${allocation.name}: ${errorText(error)}`);
      }
    }
  }

  async function sweep(): Promise<void> {
    let current: SandboxPolicy;
    try {
      current = await readPolicy();
    } catch (error) {
      bb.log.warn(`${label}: sweep skipped, policy is invalid: ${errorText(error)}`);
      return;
    }
    const at = now();
    const { owned, complete } = await owners();
    await importAllocations(owned, at);
    await sweepAllocations(owned, complete, current, at);
    const capped = monthlyCapRefusal(label, await usage());
    const unbudgeted = current.monthlyCapUsd !== null && current.hourlyRateUsd === null;
    if (capped !== null) bb.log.warn(`${capped} Suspending running sandboxes.`);
    const idleMs = current.idleMinutes === null ? null : current.idleMinutes * MINUTE;
    const renewMs = current.ttlRenewMinutes * MINUTE;
    for (const { host, resource } of owned.values()) {
      if (host.lifecycle.phase !== "active" || inFlight.has(resource.name)) continue;
      try {
        if (capped !== null) {
          await requestSuspend(host, "monthly cap");
          continue;
        }
        const lastActive = await readIdle(host.id);
        if (lastActive === null) {
          await bumpIdle(host.id);
          continue;
        }
        if (idleMs !== null && at >= lastActive + idleMs) {
          await requestSuspend(host, "idle");
          continue;
        }
        if (unbudgeted || at - lastActive >= Math.min(renewMs, idleMs ?? renewMs)) continue;
        const allocation = await readAllocation(resource.name);
        if (allocation === null || allocation.expiresAt === null || allocation.expiresAt - at > renewMs) continue;
        await extendAllocation(allocation, current);
      } catch (error) {
        bb.log.warn(`${label}: sweep failed for ${host.id}: ${errorText(error)}`);
      }
    }
  }

  async function extendTtl(hostId: string): Promise<number | null> {
    const current = await readPolicy();
    for (const allocation of await listAllocations()) {
      if (allocation.hostId === hostId) return extendAllocation(allocation, current);
    }
    return null;
  }

  async function guarded<T>(name: string, run: () => Promise<T>): Promise<T> {
    inFlight.add(name);
    try {
      return await run();
    } finally {
      inFlight.delete(name);
    }
  }

  async function settleAfterFailure(resource: Pick<SandboxResource, "key" | "name">, fallback: "suspended" | "stopped") {
    const live = await backend.listByName(resource.name, AbortSignal.timeout(vendorTimeoutMs)).catch(() => null);
    if (live === null) return;
    const stored = await readAllocation(resource.name);
    if (stored === null || stored.state === "suspended" || stored.state === "stopped") return;
    const running = live.find((handle) => handle.running && handle.id === stored.sandboxId) ?? live.find((handle) => handle.running);
    if (running !== undefined) {
      await patchAllocation(resource.key, resource.name, (allocation, at) => ({
        state: "running",
        sandboxId: running.id,
        accruedAt: allocation.accruedAt ?? at,
        expiresAt: running.expiresAt ?? allocation.expiresAt,
      }));
      return;
    }
    await patchAllocation(resource.key, resource.name, () => ({ state: fallback, accruedAt: null }));
  }

  async function resolvePendingSnapshots(key: string, name: string, signal: AbortSignal): Promise<Allocation | null> {
    const stored = await readAllocation(name);
    if (stored === null || stored.pendingSnapshotOps.length === 0) return stored;
    const found: string[] = [];
    for (const operationKey of stored.pendingSnapshotOps) {
      const snapshotId = await backend.findSnapshot({ name, operationKey, signal });
      if (snapshotId !== null) found.push(snapshotId);
    }
    return patchAllocation(key, name, (allocation) => ({
      snapshotIds: unique([...allocation.snapshotIds, ...found]),
      pendingSnapshotOps: allocation.pendingSnapshotOps.filter((op) => !stored.pendingSnapshotOps.includes(op)),
    }));
  }

  bb.experimental_environments.register({
    id: backend.id,
    displayName: backend.displayName,
    description: backend.environmentDescription ?? `Create a project checkout in a new ${backend.displayName}.`,
    icon: backend.icon,
    machineProviderId: backend.id,
    environmentProviderId: COMPOSED_ENVIRONMENT_PROVIDER,
  });

  const declaration: Declaration<S> = {
    id: backend.id,
    displayName: backend.displayName,
    description: backend.description,
    icon: backend.icon,
    ephemeral: backend.ephemeral ?? true,
    inputs: backend.inputs,
    async availability() {
      const base: SandboxAvailability = backend.availability
        ? redactDecision(await backend.availability())
        : { status: "available" };
      if (base.status !== "available") return base;
      let current: SandboxPolicy;
      try {
        current = await readPolicy();
      } catch (error) {
        return { status: "setup-required", message: `${label}: the sandbox policy is invalid: ${errorText(error)}` };
      }
      if (current.monthlyCapUsd !== null && current.hourlyRateUsd === null) {
        return { status: "setup-required", message: missingRateMessage(label, current.monthlyCapUsd) };
      }
      const capped = monthlyCapRefusal(label, await usage());
      return capped === null ? base : { status: "unavailable", message: capped };
    },
    async validate({ inputs }) {
      const found = findSecretLike(inputs);
      if (found !== null) {
        return {
          action: "refuse",
          message: `${label}: machine inputs hold a credential-like value at ${found}. Inputs are readable by every plugin; use plugin secret settings or Machine environment instead.`,
        };
      }
      const refusal = await refusalFor(null);
      if (refusal !== null) return { action: "refuse", message: refusal };
      return backend.validate ? redactDecision(await backend.validate(inputs)) : { action: "accept" };
    },
    async create(context) {
      const name = nameFor(context.key);
      const report = redactingReport(context.report);
      return guarded(name, async () => {
        try {
          assertSecretFree(context.inputs, "machine inputs");
          const refusal = await reserve(context.key, name, "allocating");
          if (refusal !== null) return { status: "failed", message: refusal };
          const current = await readPolicy();
          let resource: SandboxResource = {
            v: SANDBOX_RESOURCE_VERSION,
            providerId: backend.id,
            key: context.key,
            name,
            state: "allocating",
            sandboxId: null,
            snapshotId: null,
            snapshotSandboxId: null,
            staleSnapshotIds: [],
            init: "unknown",
            meta: {},
          };
          await context.checkpoint(asResource(resource));
          const live = await backend.listByName(name, context.signal);
          let handle = live.find((candidate) => candidate.running) ?? null;
          if (handle !== null) {
            report.log(`Reusing ${label} sandbox ${handle.id} from an earlier attempt`);
          } else {
            report.step(`Creating the ${label} sandbox…`);
            handle = await backend.create({
              key: context.key,
              name,
              inputs: context.inputs,
              ttlMs: current.ttlMinutes * MINUTE,
              signal: context.signal,
              report,
            });
          }
          context.signal.throwIfAborted();
          const created = handle;
          await patchAllocation(context.key, name, (allocation, at) => ({
            state: "running",
            sandboxId: created.id,
            accruedAt: allocation.accruedAt ?? at,
            expiresAt: created.expiresAt,
          }));
          assertSecretFree(created.meta ?? {}, "sandbox metadata");
          resource = { ...resource, state: "running", sandboxId: created.id, meta: created.meta ?? {} };
          await context.checkpoint(asResource(resource));
          const init = await probeInit(created.id, report, context.signal);
          if (init !== resource.init) {
            resource = { ...resource, init };
            await context.checkpoint(asResource(resource));
          }
          const { hostId } = await bootstrap(context.key, created.id, report, context.signal);
          context.signal.throwIfAborted();
          await patchAllocation(context.key, name, () => ({ hostId }));
          await bumpIdle(hostId);
          return { status: "created", name: machineName(hostId), resource: asResource(resource) };
        } catch (error) {
          await settleAfterFailure({ key: context.key, name }, "stopped");
          context.signal.throwIfAborted();
          return { status: "failed", message: errorText(error) };
        }
      });
    },
    async reconcileCleanup({ key, report: rawReport, signal }) {
      const name = nameFor(key);
      const report = redactingReport(rawReport);
      return guarded(name, async () => {
        try {
          const live = await backend.listByName(name, signal);
          if (live.length > 0) {
            report.step(`Removing ${live.length} uncertain ${label} allocation(s)…`);
            await backend.remove({ name, sandboxIds: live.map((handle) => handle.id), snapshotIds: [], signal, report });
          }
          if ((await backend.listByName(name, signal)).length > 0) {
            return { status: "failed", message: `${label}: ${name} is still present; retry cleanup.` };
          }
          await dropAllocation(name);
          return { status: "removed" };
        } catch (error) {
          signal.throwIfAborted();
          return { status: "failed", message: errorText(error) };
        }
      });
    },
    async suspend(context) {
      const resource = readSandboxResource(context.resource);
      const report = redactingReport(context.report);
      return guarded(resource.name, async () => {
        try {
          const live = await backend.listByName(resource.name, context.signal);
          const running = live.filter((handle) => handle.running);
          let next: SandboxResource = resource;
          if (running.length === 0) {
            const stoppedInPlace = resource.sandboxId !== null && live.some((handle) => handle.id === resource.sandboxId);
            const savedThisCompute =
              resource.snapshotId !== null &&
              (resource.state === "suspended" || resource.snapshotSandboxId === resource.sandboxId);
            if (!savedThisCompute && !stoppedInPlace) {
              throw new Error(
                resource.snapshotId === null
                  ? `${label}: compute for ${resource.name} is gone and there is no saved snapshot or stopped sandbox to restore; refusing to report it suspended. Remove the machine to clean up.`
                  : `${label}: compute ${resource.sandboxId} for ${resource.name} is gone and its last snapshot was taken from earlier compute, so changes since the last resume would be lost; refusing to report it suspended. Remove the machine to clean up.`,
              );
            }
            next = { ...resource, state: "suspended" };
            if (resource.state !== "suspended") await context.checkpoint(asResource(next));
          } else {
            const primary = running.find((handle) => handle.id === resource.sandboxId) ?? running[0]!;
            const duplicates = running.filter((handle) => handle.id !== primary.id);
            if (duplicates.length > 0) {
              report.log(`Removing ${duplicates.length} duplicate ${label} allocation(s) for ${resource.name}`);
              await backend.remove({
                name: resource.name,
                sandboxIds: duplicates.map((handle) => handle.id),
                snapshotIds: [],
                signal: context.signal,
                report,
              });
            }
            await resolvePendingSnapshots(resource.key, resource.name, context.signal);
            const operationKey = `${resource.name}-${globalThis.crypto.randomUUID().slice(0, 12)}`;
            await patchAllocation(resource.key, resource.name, (allocation) => ({
              pendingSnapshotOps: unique([...allocation.pendingSnapshotOps, operationKey]),
            }));
            report.step(`Saving the ${label} sandbox…`);
            const saved = await backend.snapshot({
              sandboxId: primary.id,
              name: resource.name,
              operationKey,
              signal: context.signal,
              report,
            });
            const tracked = await patchAllocation(resource.key, resource.name, (allocation) => ({
              snapshotIds: unique([...allocation.snapshotIds, saved.snapshotId]),
              pendingSnapshotOps: allocation.pendingSnapshotOps.filter((op) => op !== operationKey),
            }));
            const snapshotId = saved.snapshotId ?? resource.snapshotId;
            next = {
              ...resource,
              sandboxId: primary.id,
              snapshotId,
              snapshotSandboxId: saved.snapshotId !== null ? primary.id : resource.snapshotSandboxId,
              staleSnapshotIds: unique(
                [...resource.staleSnapshotIds, resource.snapshotId, ...tracked.snapshotIds].filter((id) => id !== snapshotId),
              ),
            };
            await context.checkpoint(asResource(next));
            report.step(`Stopping the ${label} sandbox…`);
            const stopped = await backend.stop({
              sandboxId: primary.id,
              name: resource.name,
              signal: context.signal,
              report,
            });
            next = { ...next, state: "suspended", sandboxId: stopped.sandboxId };
            await context.checkpoint(asResource(next));
            if (next.snapshotId === null && next.sandboxId === null) {
              throw new Error(
                `${label}: ${resource.name} stopped without a snapshot or a stopped sandbox to restore; its state is lost.`,
              );
            }
          }
          const after = await backend.listByName(resource.name, context.signal);
          const still = after.filter((handle) => handle.running);
          if (still.length > 0) {
            throw new Error(
              `${label}: ${still.length} ${resource.name} allocation(s) are still running after suspend; retry.`,
            );
          }
          await patchAllocation(resource.key, resource.name, (allocation) => ({
            state: "suspended",
            hostId: context.hostId,
            sandboxId: next.sandboxId,
            snapshotIds: unique([...allocation.snapshotIds, next.snapshotId, ...next.staleSnapshotIds]),
            accruedAt: null,
          }));
          await kv.delete(`${IDLE_PREFIX}${context.hostId}`);
          return { resource: asResource(next) };
        } catch (error) {
          context.signal.throwIfAborted();
          throw new Error(errorText(error));
        }
      });
    },
    async resume(context) {
      const resource = readSandboxResource(context.resource);
      const report = redactingReport(context.report);
      return guarded(resource.name, async () => {
        try {
          const refusal = await reserve(resource.key, resource.name, "resuming");
          if (refusal !== null) throw new Error(refusal);
          const current = await readPolicy();
          const live = await backend.listByName(resource.name, context.signal);
          let handle = live.find((candidate) => candidate.running) ?? null;
          if (handle !== null) {
            report.log(`Reusing running ${label} sandbox ${handle.id}`);
          } else {
            report.step(`Resuming the ${label} sandbox…`);
            handle = await backend.resume({
              name: resource.name,
              sandboxId: resource.sandboxId,
              snapshotId: resource.snapshotId,
              meta: resource.meta,
              ttlMs: current.ttlMinutes * MINUTE,
              signal: context.signal,
              report,
            });
          }
          context.signal.throwIfAborted();
          const resumed = handle;
          await patchAllocation(resource.key, resource.name, (allocation, at) => ({
            state: "running",
            hostId: context.hostId,
            sandboxId: resumed.id,
            accruedAt: allocation.accruedAt ?? at,
            expiresAt: resumed.expiresAt,
          }));
          assertSecretFree(resumed.meta ?? {}, "sandbox metadata");
          let next: SandboxResource = {
            ...resource,
            state: "running",
            sandboxId: resumed.id,
            meta: { ...resource.meta, ...resumed.meta },
          };
          await context.checkpoint(asResource(next));
          await bootstrap(resource.key, resumed.id, report, context.signal);
          await bumpIdle(context.hostId);
          if (next.staleSnapshotIds.length > 0) {
            try {
              const deleted = next.staleSnapshotIds;
              await backend.remove({
                name: resource.name,
                sandboxIds: [],
                snapshotIds: deleted,
                signal: context.signal,
                report,
              });
              next = { ...next, staleSnapshotIds: [] };
              await context.checkpoint(asResource(next));
              await patchAllocation(resource.key, resource.name, (allocation) => ({
                snapshotIds: allocation.snapshotIds.filter((id) => !deleted.includes(id)),
              }));
            } catch (error) {
              report.log(`Stale snapshot cleanup will retry later: ${errorText(error)}`);
            }
          }
          return { resource: asResource(next) };
        } catch (error) {
          await settleAfterFailure(resource, "suspended");
          context.signal.throwIfAborted();
          throw new Error(errorText(error));
        }
      });
    },
    async remove(context) {
      let resource: SandboxResource;
      try {
        resource = readSandboxResource(context.resource);
      } catch (error) {
        return { status: "failed", message: `${label}: unreadable machine resource: ${errorText(error)}` };
      }
      const report = redactingReport(context.report);
      return guarded(resource.name, async () => {
        try {
          const live = await backend.listByName(resource.name, context.signal);
          const sandboxIds = unique([resource.sandboxId, ...live.map((handle) => handle.id)]);
          const stored = await resolvePendingSnapshots(resource.key, resource.name, context.signal);
          const snapshotIds = unique([resource.snapshotId, ...resource.staleSnapshotIds, ...(stored?.snapshotIds ?? [])]);
          if (sandboxIds.length > 0 || snapshotIds.length > 0) {
            report.step(`Removing the ${label} sandbox…`);
            await backend.remove({ name: resource.name, sandboxIds, snapshotIds, signal: context.signal, report });
          }
          if ((await backend.listByName(resource.name, context.signal)).length > 0) {
            return { status: "failed", message: `${label}: ${resource.name} is still present; retry removal.` };
          }
          await dropAllocation(resource.name);
          await kv.delete(`${IDLE_PREFIX}${context.hostId}`);
          return { status: "removed" };
        } catch (error) {
          context.signal.throwIfAborted();
          return { status: "failed", message: errorText(error) };
        }
      });
    },
  };
  bb.experimental_machines.register(declaration);

  bb.events.on("experimental_thread.events", async ({ thread }) => {
    if (thread.status !== "starting" && thread.status !== "active") return;
    try {
      if (thread.environmentId === null) {
        const match = (await owners()).owned.get(thread.id);
        if (match !== undefined && match.host.lifecycle.phase === "active") await bumpIdle(match.host.id);
        return;
      }
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      await bumpOwned(environment.hostId);
    } catch (error) {
      bb.log.debug(`${label}: idle bump skipped for ${thread.id}: ${errorText(error)}`);
    }
  });

  bb.events.on("experimental_terminal.input", async ({ terminal }) => {
    try {
      await bumpOwned(terminal.hostId);
    } catch (error) {
      bb.log.debug(`${label}: idle bump skipped for terminal ${terminal.id}: ${errorText(error)}`);
    }
  });

  bb.background.schedule(options.scheduleName ?? "sandbox-sweep", "* * * * *", sweep);

  if (options.launchCheck !== false) {
    bb.experimental_hooks.on("message.dispatch", createCloudLaunchCheck(bb, backend.id, options.launchCheck ?? {}));
  }

  return { sweep, bumpIdle, extendTtl, usage, refusal: () => refusalFor(null) };
}
