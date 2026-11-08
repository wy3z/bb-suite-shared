import type { SandboxBackend, SandboxHandle, SandboxPluginApi } from "../src/machine-backend-server.ts";

export type Phase = "active" | "creating" | "destroyed" | "removing" | "resuming" | "suspended" | "suspending";

export interface FakeHost {
  id: string;
  machineProviderId: string | null;
  lifecycle: { phase: Phase };
}

export interface FakeSandbox {
  id: string;
  name: string;
  running: boolean;
  expiresAt: number | null;
  snapshotId: string | null;
}

export class Clock {
  constructor(public value = Date.UTC(2026, 10, 8, 9, 0, 0)) {}
  now = () => this.value;
  advance(minutes: number) {
    this.value += minutes * 60_000;
  }
}

export function fakeBackend(clock: Clock, init = "none") {
  const sandboxes = new Map<string, FakeSandbox>();
  const snapshots = new Set<string>();
  const calls = { create: 0, suspend: 0, resume: 0, remove: [] as Array<{ sandboxIds: string[]; snapshotIds: string[] }>, extend: 0, exec: [] as string[][] };
  const faults: { create?: Error; exec?: Error; meta?: Record<string, string>; keepAfterRemove?: boolean } = {};
  let seq = 0;
  const handle = (sandbox: FakeSandbox): SandboxHandle => ({
    id: sandbox.id,
    running: sandbox.running,
    expiresAt: sandbox.expiresAt,
    ...(faults.meta ? { meta: faults.meta } : { meta: { region: "eu" } }),
  });
  const backend: SandboxBackend = {
    id: "fake-sandbox",
    displayName: "Fake Sandbox",
    description: "A sandbox that lives in memory.",
    icon: "cloud",
    async create({ name, ttlMs }) {
      calls.create += 1;
      if (faults.create) throw faults.create;
      seq += 1;
      const sandbox = { id: `sb-${seq}`, name, running: true, expiresAt: clock.now() + ttlMs, snapshotId: null };
      sandboxes.set(sandbox.id, sandbox);
      return handle(sandbox);
    },
    async exec(sandboxId, request) {
      calls.exec.push([sandboxId, ...request.command]);
      if (faults.exec) throw faults.exec;
      if (request.command.join(" ").includes("systemd")) request.onOutput(`${init}\n`);
      return { exitCode: 0 };
    },
    async suspend({ sandboxId }) {
      calls.suspend += 1;
      const sandbox = sandboxes.get(sandboxId);
      if (!sandbox) throw new Error("missing");
      seq += 1;
      const snapshotId = `snap-${seq}`;
      snapshots.add(snapshotId);
      sandboxes.delete(sandboxId);
      return { sandboxId: null, snapshotId };
    },
    async resume({ name, snapshotId, ttlMs }) {
      calls.resume += 1;
      if (snapshotId === null || !snapshots.has(snapshotId)) throw new Error("no snapshot");
      seq += 1;
      const sandbox = { id: `sb-${seq}`, name, running: true, expiresAt: clock.now() + ttlMs, snapshotId };
      sandboxes.set(sandbox.id, sandbox);
      return handle(sandbox);
    },
    async remove({ sandboxIds, snapshotIds }) {
      calls.remove.push({ sandboxIds: [...sandboxIds], snapshotIds: [...snapshotIds] });
      if (faults.keepAfterRemove) return;
      for (const id of sandboxIds) sandboxes.delete(id);
      for (const id of snapshotIds) snapshots.delete(id);
    },
    async listByName(name) {
      return [...sandboxes.values()].filter((sandbox) => sandbox.name === name).map(handle);
    },
    async extendTtl({ sandboxId, ttlMs }) {
      calls.extend += 1;
      const sandbox = sandboxes.get(sandboxId);
      if (!sandbox) throw new Error("missing");
      sandbox.expiresAt = clock.now() + ttlMs;
      return { expiresAt: sandbox.expiresAt };
    },
  };
  return { backend, sandboxes, snapshots, calls, faults };
}

type Declaration = Parameters<SandboxPluginApi["experimental_machines"]["register"]>[0];
type Handler = (payload: never) => unknown;

export function fakeBb(clock: Clock) {
  const kv = new Map<string, unknown>();
  const hosts: FakeHost[] = [];
  const resources = new Map<string, unknown>();
  const environments = new Map<string, string>();
  const handlers = new Map<string, Handler[]>();
  const schedules: Array<{ name: string; cron: string; fn: () => unknown }> = [];
  const logs: string[] = [];
  const state = {
    declaration: null as Declaration | null,
    environment: null as unknown,
    bootstraps: [] as Array<{ key: string }>,
    suspends: [] as string[],
    reconciles: [] as string[],
    bootstrapFault: null as Error | null,
    suspendFault: null as Error | null,
    nextHost: 0,
    dispatch: null as ((context: never) => Promise<unknown>) | null,
    envReads: [] as string[],
    poolReads: 0,
    envFault: null as Error | null,
    globalEnv: [] as string[],
    projectEnv: [] as string[],
    builtInGit: "logged in" as string,
    pool: null as unknown,
  };
  const api = {
    log: {
      debug: (m: string) => logs.push(`debug ${m}`),
      info: (m: string) => logs.push(`info ${m}`),
      warn: (m: string) => logs.push(`warn ${m}`),
      error: (m: string) => logs.push(`error ${m}`),
    },
    storage: {
      kv: {
        async get(key: string) {
          return structuredClone(kv.get(key));
        },
        async set(key: string, value: unknown) {
          kv.set(key, structuredClone(value));
        },
        async delete(key: string) {
          kv.delete(key);
        },
        async list(prefix = "") {
          return [...kv.keys()].filter((key) => key.startsWith(prefix));
        },
      },
    },
    background: {
      schedule(name: string, cron: string, fn: () => unknown) {
        schedules.push({ name, cron, fn });
      },
    },
    experimental_hooks: {
      on(hook: string, handler: (context: never) => Promise<unknown>) {
        if (hook !== "message.dispatch" || state.dispatch) throw new Error("unexpected hook");
        state.dispatch = handler;
      },
    },
    events: {
      on(event: string, handler: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    },
    experimental_machines: {
      register(declaration: Declaration) {
        state.declaration = declaration;
      },
      async bootstrap(request: { key: string; executor: { exec: (r: unknown) => Promise<unknown> }; signal: AbortSignal }) {
        state.bootstraps.push({ key: request.key });
        await request.executor.exec({ command: ["sh", "-c", "install"], timeoutMs: 1000, signal: request.signal, stdin: "{}", onOutput: () => {} });
        if (state.bootstrapFault) throw state.bootstrapFault;
        const existing = hosts.find((host) => (resources.get(host.id) as { key?: string } | undefined)?.key === request.key);
        if (existing) return { hostId: existing.id };
        state.nextHost += 1;
        return { hostId: `host_${state.nextHost}abcdef` };
      },
      async getResource(hostId: string) {
        return (resources.get(hostId) ?? null) as never;
      },
    },
    experimental_environments: {
      register(declaration: unknown) {
        state.environment = declaration;
      },
    },
    sdk: {
      hosts: {
        async list() {
          return hosts.map((host) => ({ ...host, lifecycle: { ...host.lifecycle } }));
        },
        async get({ hostId }: { hostId: string }) {
          const host = hosts.find((candidate) => candidate.id === hostId);
          if (!host) throw new Error("not found");
          return { ...host, lifecycle: { ...host.lifecycle } };
        },
        async experimental_suspend({ hostId }: { hostId: string }) {
          state.suspends.push(hostId);
          if (state.suspendFault) throw state.suspendFault;
          return hosts.find((host) => host.id === hostId);
        },
        async experimental_reconcile({ hostId }: { hostId: string }) {
          state.reconciles.push(hostId);
          return hosts.find((host) => host.id === hostId);
        },
      },
      projects: {
        async machineEnvironment({ projectId }: { projectId: string }) {
          state.envReads.push(projectId);
          if (state.envFault) throw state.envFault;
          const row = (name: string) => ({ name, note: null, secret: true, value: null });
          return {
            builtInGit: { status: state.builtInGit, statusMessage: "" },
            inheritedVariables: state.globalEnv.map(row),
            variables: state.projectEnv.map(row),
          };
        },
      },
      plugins: {
        async callRpc({ pluginId, method }: { pluginId: string; method: string }) {
          state.poolReads += 1;
          if (pluginId !== "account-pool" || method !== "status.get" || state.pool === null) throw new Error("plugin not enabled");
          return state.pool;
        },
      },
      environments: {
        async get({ environmentId }: { environmentId: string }) {
          return { id: environmentId, hostId: environments.get(environmentId) ?? "unknown" };
        },
      },
    },
  };
  async function emit(event: string, payload: unknown) {
    for (const handler of handlers.get(event) ?? []) await handler(payload as never);
  }
  return {
    bb: api as unknown as SandboxPluginApi,
    kv,
    hosts,
    resources,
    environments,
    schedules,
    logs,
    state,
    emit,
    get machine(): Declaration {
      if (!state.declaration) throw new Error("not registered");
      return state.declaration;
    },
  };
}

export function report() {
  const lines: string[] = [];
  return { lines, progress: { step: (t: string) => lines.push(`step ${t}`), log: (t: string) => lines.push(`log ${t}`) } };
}
