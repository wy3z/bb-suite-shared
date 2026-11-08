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
  staleSnapshotIds: z.array(z.string().min(1)),
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
