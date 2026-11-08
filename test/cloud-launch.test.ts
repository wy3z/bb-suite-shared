import { describe, expect, it } from "bun:test";
import {
  DEFAULT_CLOUD_LOGIN_RULES,
  evaluateCloudLogin,
  registerSandboxBackend,
  type CloudLoginRules,
} from "../src/machine-backend-server.ts";
import { Clock, fakeBackend, fakeBb } from "./sandbox-fakes.ts";

function setup(options: Parameters<typeof registerSandboxBackend>[3] = {}) {
  const clock = new Clock();
  const sdk = fakeBb(clock);
  const fake = fakeBackend(clock);
  registerSandboxBackend(sdk.bb, fake.backend, { hourlyRateUsd: 0.5 }, { now: clock.now, ...options });
  return sdk;
}

type Target = "new-sandbox" | "sandbox-host" | "local" | "other-cloud";

function context(providerId: string, target: Target = "new-sandbox", attempt = "start-turn") {
  const host =
    target === "sandbox-host"
      ? { id: "host_sb", machineProviderId: "fake-sandbox" }
      : target === "local"
        ? { id: "host_arch", machineProviderId: null }
        : target === "other-cloud"
          ? { id: "host_other", machineProviderId: "modal-sandbox" }
          : null;
  const environmentIntent =
    target === "new-sandbox"
      ? {
          kind: "provider",
          environmentProviderId: "project-checkout",
          machine: { type: "new", machineProviderId: "fake-sandbox", inputs: null },
          inputs: null,
        }
      : { kind: "environment", environmentId: "env_1" };
  return {
    thread: { id: "thr_1" },
    project: { id: "proj_1" },
    environment: null,
    host,
    environmentIntent,
    requestedExecution: { providerId, model: null, reasoningLevel: null, serviceTier: null, permissionMode: null },
    attempt,
  } as never;
}

function pool(routing: Record<string, boolean>, accounts: Array<Record<string, unknown>>) {
  return { route: "/pool", routing, accounts, hosts: [], accepting: true, inFlight: 0, enabledAccountCount: accounts.length };
}

async function decide(sdk: ReturnType<typeof setup>, ctx: never) {
  return sdk.state.dispatch!(ctx) as Promise<{ action: string; message?: string }>;
}

describe("cloud launch check", () => {
  it("installs exactly one message.dispatch hook, or none when disabled", () => {
    expect(setup().state.dispatch).not.toBeNull();
    expect(setup({ launchCheck: false }).state.dispatch).toBeNull();
  });

  it("passes local threads and other machine providers through without reading anything", async () => {
    const sdk = setup();
    expect(await decide(sdk, context("codex", "local"))).toEqual({ action: "proceed" });
    expect(await decide(sdk, context("codex", "other-cloud"))).toEqual({ action: "proceed" });
    expect(await decide(sdk, context("codex", "sandbox-host", "join-turn"))).toEqual({ action: "proceed" });
    expect(sdk.state.envReads).toEqual([]);
    expect(sdk.state.poolReads).toBe(0);
  });

  it("allows Claude Code with a global or project CLAUDE_CODE_OAUTH_TOKEN row, by name only", async () => {
    const sdk = setup();
    sdk.state.globalEnv = ["CLAUDE_CODE_OAUTH_TOKEN"];
    expect(await decide(sdk, context("claude-code"))).toEqual({ action: "proceed" });
    sdk.state.globalEnv = [];
    sdk.state.projectEnv = ["CLAUDE_CODE_OAUTH_TOKEN"];
    expect(await decide(sdk, context("claude-code", "sandbox-host"))).toEqual({ action: "proceed" });
    expect(sdk.state.envReads).toEqual(["proj_1", "proj_1"]);
    expect(sdk.state.poolReads).toBe(0);
  });

  it("allows Claude Code through pool routing and rejects it with neither", async () => {
    const sdk = setup();
    sdk.state.pool = pool({ claude: true, codex: false }, [{ provider: "claude", enabled: true, status: "ready", error: null }]);
    expect(await decide(sdk, context("claude-code"))).toEqual({ action: "proceed" });
    sdk.state.pool = pool({ claude: false, codex: false }, [{ provider: "claude", enabled: true, status: "ready", error: null }]);
    const rejected = await decide(sdk, context("claude-code"));
    expect(rejected.action).toBe("reject");
    expect(rejected.message).toStartWith("Cloud thread blocked: Claude Code has no login for cloud machines. Fix: run `claude setup-token`");
  });

  it("requires Account Pooler routing with a usable Codex account for codex", async () => {
    const sdk = setup();
    sdk.state.globalEnv = ["CLAUDE_CODE_OAUTH_TOKEN", "OPENCODE_API_KEY"];
    const noPool = await decide(sdk, context("codex"));
    expect(noPool.action).toBe("reject");
    expect(noPool.message).toContain("Codex has no pooled login for cloud machines");
    expect(noPool.message).toContain("bb pool account add --provider codex --login");
    sdk.state.pool = pool({ claude: false, codex: true }, [{ provider: "codex", enabled: true, status: "error", error: "refresh failed" }]);
    expect((await decide(sdk, context("codex"))).action).toBe("reject");
    sdk.state.pool = pool({ claude: false, codex: true }, [{ provider: "codex", enabled: false, status: "disabled", error: null }]);
    expect((await decide(sdk, context("codex"))).action).toBe("reject");
    sdk.state.pool = pool({ claude: false, codex: true }, [{ provider: "codex", enabled: true, status: "held", error: null }]);
    expect(await decide(sdk, context("codex"))).toEqual({ action: "proceed" });
    sdk.state.pool = { status: pool({ claude: false, codex: true }, [{ provider: "codex", enabled: true, status: "ready", error: null }]) };
    expect(await decide(sdk, context("codex"))).toEqual({ action: "proceed" });
  });

  it("checks OPENCODE_API_KEY for acp-opencode and pi, naming the provider", async () => {
    const sdk = setup();
    const rejected = await decide(sdk, context("pi"));
    expect(rejected.message).toBe(
      "Cloud thread blocked: pi has no OpenCode Go key for cloud machines. Fix: `bb machine env set OPENCODE_API_KEY` (value on stdin).",
    );
    sdk.state.projectEnv = ["OPENCODE_API_KEY"];
    expect(await decide(sdk, context("acp-opencode"))).toEqual({ action: "proceed" });
    expect(await decide(sdk, context("pi"))).toEqual({ action: "proceed" });
  });

  it("rejects unknown providers and missing GitHub credentials", async () => {
    const sdk = setup();
    sdk.state.globalEnv = ["CLAUDE_CODE_OAUTH_TOKEN"];
    expect((await decide(sdk, context("gemini"))).message).toContain("no cloud login rule for provider 'gemini'");
    sdk.state.builtInGit = "not logged in";
    expect((await decide(sdk, context("claude-code"))).message).toContain("no GitHub credential for cloud machines");
    sdk.state.projectEnv = ["GH_TOKEN"];
    expect(await decide(sdk, context("claude-code"))).toEqual({ action: "proceed" });
  });

  it("rejects with an explanation instead of throwing when the check itself fails", async () => {
    const sdk = setup();
    sdk.state.envFault = new Error("db locked, token=abc123");
    const rejected = await decide(sdk, context("claude-code"));
    expect(rejected.action).toBe("reject");
    expect(rejected.message).toContain("could not check cloud logins for claude-code");
    expect(rejected.message).not.toContain("abc123");
  });

  it("uses vendor-supplied rules", async () => {
    const rules: CloudLoginRules = {
      ...DEFAULT_CLOUD_LOGIN_RULES,
      providers: [
        ...DEFAULT_CLOUD_LOGIN_RULES.providers,
        { providerIds: ["gemini"], anyOf: [{ kind: "machine-env", name: "GEMINI_API_KEY" }], problem: "Gemini has no key", fix: "set GEMINI_API_KEY" },
      ],
      unknownProvider: null,
    };
    const sdk = setup({ launchCheck: { rules } });
    sdk.state.globalEnv = ["GEMINI_API_KEY"];
    expect(await decide(sdk, context("gemini"))).toEqual({ action: "proceed" });
    expect(await decide(sdk, context("mystery"))).toEqual({ action: "proceed" });
  });
});

describe("evaluateCloudLogin", () => {
  it("is a pure function over names and pool facts", () => {
    const facts = { envNames: ["OPENCODE_API_KEY"], builtInGit: true, pool: null };
    expect(evaluateCloudLogin("acp-opencode", facts)).toEqual({ ok: true });
    expect(evaluateCloudLogin("codex", facts).ok).toBe(false);
    expect(
      evaluateCloudLogin("codex", { ...facts, pool: { routing: { codex: true }, usableProviders: ["codex"] } }),
    ).toEqual({ ok: true });
  });
});
