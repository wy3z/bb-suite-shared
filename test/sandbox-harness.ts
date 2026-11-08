import {
  readSandboxResource,
  registerSandboxBackend,
  type SandboxPolicySource,
  type SandboxRegistrationOptions,
  type SandboxResource,
} from "../src/machine-backend-server.ts";
import { Clock, fakeBackend, fakeBb, report } from "./sandbox-fakes.ts";

export const signal = () => new AbortController().signal;

export function setup(policy: SandboxPolicySource = { hourlyRateUsd: 0.5 }, init = "none", options: SandboxRegistrationOptions = {}) {
  const clock = new Clock();
  const sdk = fakeBb(clock);
  const fake = fakeBackend(clock, init);
  const registration = registerSandboxBackend(sdk.bb, fake.backend, policy, { now: clock.now, ...options });

  async function create(key: string, attempt = 1, inputs: unknown = null) {
    const checkpoints: SandboxResource[] = [];
    const progress = report();
    const before = sdk.state.nextHost;
    const result = await sdk.machine.create({
      key,
      attempt,
      inputs: inputs as never,
      checkpoint: async (resource) => {
        checkpoints.push(readSandboxResource(resource));
      },
      report: progress.progress,
      signal: signal(),
    });
    let hostId: string | null = null;
    if (result.status === "created") {
      hostId = sdk.state.nextHost > before ? `host_${sdk.state.nextHost}abcdef` : sdk.hosts.find((h) => readSandboxResource(sdk.resources.get(h.id)).key === key)!.id;
      if (!sdk.hosts.some((host) => host.id === hostId)) {
        sdk.hosts.push({ id: hostId, machineProviderId: "fake-sandbox", lifecycle: { phase: "active" } });
      }
      sdk.resources.set(hostId, result.resource);
    }
    return { result, checkpoints, lines: progress.lines, hostId };
  }

  function host(hostId: string) {
    return sdk.hosts.find((candidate) => candidate.id === hostId)!;
  }

  async function suspend(hostId: string, opts: { failCheckpoint?: number; lines?: string[] } = {}) {
    const progress = report();
    let checkpoints = 0;
    const out = await sdk.machine.suspend!({
      hostId,
      resource: sdk.resources.get(hostId) as never,
      checkpoint: async (resource) => {
        checkpoints += 1;
        if (checkpoints === opts.failCheckpoint) throw new Error("checkpoint write failed");
        sdk.resources.set(hostId, resource);
      },
      report: progress.progress,
      signal: signal(),
    });
    opts.lines?.push(...progress.lines);
    sdk.resources.set(hostId, out.resource);
    host(hostId).lifecycle.phase = "suspended";
    return readSandboxResource(out.resource);
  }

  async function resume(hostId: string) {
    const progress = report();
    const out = await sdk.machine.resume!({
      hostId,
      resource: sdk.resources.get(hostId) as never,
      checkpoint: async (resource) => {
        sdk.resources.set(hostId, resource);
      },
      report: progress.progress,
      signal: signal(),
    });
    sdk.resources.set(hostId, out.resource);
    host(hostId).lifecycle.phase = "active";
    return readSandboxResource(out.resource);
  }

  async function remove(hostId: string) {
    const progress = report();
    const out = await sdk.machine.remove({
      hostId,
      resource: sdk.resources.get(hostId) as never,
      report: progress.progress,
      signal: signal(),
    });
    if (out.status === "removed") host(hostId).lifecycle.phase = "destroyed";
    return out;
  }

  async function allocation(name: string) {
    return sdk.kv.get(`sandbox/alloc/${name}`) as Record<string, unknown> | undefined;
  }

  return { clock, sdk, fake, registration, create, suspend, resume, remove, host, allocation };
}
