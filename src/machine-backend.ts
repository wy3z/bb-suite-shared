import { z } from "zod";

export const SANDBOX_RESOURCE_VERSION = 1;
export const COMPOSED_ENVIRONMENT_PROVIDER = "project-checkout";

export const sandboxPolicySchema = z.object({
  idleMinutes: z.number().positive().nullable().default(15),
  ttlMinutes: z.number().positive().default(120),
  ttlRenewMinutes: z.number().positive().default(15),
  maxConcurrent: z.number().int().positive().nullable().default(2),
  monthlyCapUsd: z.number().nonnegative().nullable().default(30),
  hourlyRateUsd: z.number().nonnegative().nullable().default(null),
  orphanGraceMinutes: z.number().nonnegative().default(10),
  orphans: z.enum(["remove", "retain"]).default("remove"),
});
export type SandboxPolicyInput = z.input<typeof sandboxPolicySchema>;
export type SandboxPolicy = z.output<typeof sandboxPolicySchema>;

export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = sandboxPolicySchema.parse({});

export function resolveSandboxPolicy(input: SandboxPolicyInput): SandboxPolicy {
  return sandboxPolicySchema.parse(input);
}

export const SANDBOX_STATES = ["allocating", "running", "suspended"] as const;
export type SandboxState = (typeof SANDBOX_STATES)[number];

export const SANDBOX_INIT_KINDS = ["systemd", "none", "unknown"] as const;
export type SandboxInitKind = (typeof SANDBOX_INIT_KINDS)[number];

export const sandboxResourceSchema = z.object({
  v: z.literal(SANDBOX_RESOURCE_VERSION),
  providerId: z.string().min(1),
  key: z.string().min(1),
  name: z.string().min(1),
  state: z.enum(SANDBOX_STATES),
  sandboxId: z.string().min(1).nullable(),
  snapshotId: z.string().min(1).nullable(),
  snapshotSandboxId: z.string().min(1).nullable().default(null),
  staleSnapshotIds: z.array(z.string().min(1)),
  unverifiedSnapshotOps: z.array(z.string().min(1)).default([]),
  init: z.enum(SANDBOX_INIT_KINDS),
  meta: z.record(z.string(), z.json()),
});
export type SandboxResource = z.output<typeof sandboxResourceSchema>;

export function readSandboxResource(value: unknown): SandboxResource {
  return sandboxResourceSchema.parse(value);
}

export function isSandboxResource(value: unknown): value is SandboxResource {
  return sandboxResourceSchema.safeParse(value).success;
}

export interface SandboxUsage {
  month: string;
  runningMs: number;
  estimatedUsd: number | null;
  capUsd: number | null;
}

export function usageMonth(epochMs: number): string {
  const date = new Date(epochMs);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function monthlyCapRefusal(displayName: string, usage: SandboxUsage): string | null {
  if (usage.capUsd === null || usage.estimatedUsd === null) return null;
  if (usage.estimatedUsd < usage.capUsd) return null;
  return `${displayName}: the monthly cap of ${formatUsd(usage.capUsd)} is reached (${formatUsd(usage.estimatedUsd)} used in ${usage.month}). Raise the cap in the plugin settings or wait for next month.`;
}

export function concurrencyRefusal(displayName: string, running: number, maxConcurrent: number | null): string | null {
  if (maxConcurrent === null || running < maxConcurrent) return null;
  const noun = maxConcurrent === 1 ? "sandbox is" : "sandboxes are";
  return `${displayName}: ${running} of ${maxConcurrent} ${noun} already running (max concurrent ${maxConcurrent}). Suspend or remove one, or raise the limit in the plugin settings.`;
}

export function missingRateMessage(displayName: string, capUsd: number): string {
  return `${displayName}: set an hourly rate so the ${formatUsd(capUsd)} monthly cap can be enforced.`;
}

const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential|private[-_]?key)/i;
const SECRET_VALUE = /(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{12,})/;

export function findSecretLike(value: unknown, path = "$"): string | null {
  if (typeof value === "string") return SECRET_VALUE.test(value) ? path : null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findSecretLike(item, `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key) && item !== null && item !== "" && item !== false) return `${path}.${key}`;
      const found = findSecretLike(item, `${path}.${key}`);
      if (found !== null) return found;
    }
  }
  return null;
}

const REDACTIONS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]"],
  [/sk-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted]"],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/AKIA[0-9A-Z]{16}/g, "[redacted]"],
  [/((?:token|secret|password|api[-_]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[redacted]"],
];

export function redactSecrets(text: string): string {
  return REDACTIONS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

export type CloudLoginRequirement =
  | { kind: "machine-env"; name: string }
  | { kind: "pool"; provider: string }
  | { kind: "built-in-git" };

export interface CloudLoginRule {
  providerIds: readonly string[];
  anyOf: readonly CloudLoginRequirement[];
  problem: string;
  fix: string;
}

export interface CloudLoginRules {
  providers: readonly CloudLoginRule[];
  always: readonly CloudLoginRule[];
  unknownProvider: { problem: string; fix: string } | null;
}

export const DEFAULT_CLOUD_LOGIN_RULES: CloudLoginRules = {
  providers: [
    {
      providerIds: ["claude-code"],
      anyOf: [
        { kind: "machine-env", name: "CLAUDE_CODE_OAUTH_TOKEN" },
        { kind: "pool", provider: "claude" },
      ],
      problem: "Claude Code has no login for cloud machines",
      fix: "run `claude setup-token` on the server machine, then `bb machine env set CLAUDE_CODE_OAUTH_TOKEN` (value on stdin), or route Claude through the Account Pooler",
    },
    {
      providerIds: ["codex"],
      anyOf: [{ kind: "pool", provider: "codex" }],
      problem: "Codex has no pooled login for cloud machines (copying ~/.codex/auth.json is not supported)",
      fix: "enable the Account Pooler, add a Codex account with `bb pool account add --provider codex --login`, and turn Codex routing on",
    },
    {
      providerIds: ["acp-opencode", "pi"],
      anyOf: [{ kind: "machine-env", name: "OPENCODE_API_KEY" }],
      problem: "{provider} has no OpenCode Go key for cloud machines",
      fix: "`bb machine env set OPENCODE_API_KEY` (value on stdin)",
    },
  ],
  always: [
    {
      providerIds: [],
      anyOf: [{ kind: "built-in-git" }, { kind: "machine-env", name: "GH_TOKEN" }],
      problem: "there is no GitHub credential for cloud machines",
      fix: "run `gh auth login` on the server machine, or `bb machine env set GH_TOKEN --project <id>` (value on stdin)",
    },
  ],
  unknownProvider: {
    problem: "there is no cloud login rule for provider '{provider}'",
    fix: "use claude-code, codex, acp-opencode or pi, or add a rule for this provider",
  },
};

export interface CloudLoginFacts {
  envNames: readonly string[];
  builtInGit: boolean;
  pool: { routing: Readonly<Record<string, boolean>>; usableProviders: readonly string[] } | null;
}

export type CloudLoginVerdict = { ok: true } | { ok: false; message: string };

export function cloudLoginRuleFor(providerId: string, rules: CloudLoginRules = DEFAULT_CLOUD_LOGIN_RULES): CloudLoginRule | null {
  return rules.providers.find((rule) => rule.providerIds.includes(providerId)) ?? null;
}

export function ruleNeedsPool(rule: CloudLoginRule, facts: Omit<CloudLoginFacts, "pool">): boolean {
  return (
    rule.anyOf.some((requirement) => requirement.kind === "pool") &&
    !rule.anyOf.some((requirement) => requirement.kind !== "pool" && requirementMet(requirement, { ...facts, pool: null }))
  );
}

function requirementMet(requirement: CloudLoginRequirement, facts: CloudLoginFacts): boolean {
  if (requirement.kind === "machine-env") return facts.envNames.includes(requirement.name);
  if (requirement.kind === "built-in-git") return facts.builtInGit;
  return (
    facts.pool !== null &&
    facts.pool.routing[requirement.provider] === true &&
    facts.pool.usableProviders.includes(requirement.provider)
  );
}

function blocked(problem: string, fix: string, providerId: string): CloudLoginVerdict {
  const fill = (text: string) => text.replaceAll("{provider}", providerId);
  return { ok: false, message: `Cloud thread blocked: ${fill(problem)}. Fix: ${fill(fix)}.` };
}

export function evaluateCloudLogin(
  providerId: string,
  facts: CloudLoginFacts,
  rules: CloudLoginRules = DEFAULT_CLOUD_LOGIN_RULES,
): CloudLoginVerdict {
  const rule = cloudLoginRuleFor(providerId, rules);
  if (rule === null) {
    return rules.unknownProvider === null
      ? { ok: true }
      : blocked(rules.unknownProvider.problem, rules.unknownProvider.fix, providerId);
  }
  for (const candidate of [rule, ...rules.always]) {
    if (!candidate.anyOf.some((requirement) => requirementMet(requirement, facts))) {
      return blocked(candidate.problem, candidate.fix, providerId);
    }
  }
  return { ok: true };
}
