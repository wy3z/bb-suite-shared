import type { MessageDispatchHookContext, MessageDispatchHookDecision, PluginBbSdk } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_CLOUD_LOGIN_RULES,
  cloudLoginRuleFor,
  evaluateCloudLogin,
  redactSecrets,
  ruleNeedsPool,
  type CloudLoginFacts,
  type CloudLoginRules,
} from "./machine-backend";

export const ACCOUNT_POOL_PLUGIN = "account-pool";
export const ACCOUNT_POOL_STATUS_METHOD = "status.get";

export interface CloudLaunchApi {
  readonly sdk: {
    readonly projects: Pick<PluginBbSdk["projects"], "machineEnvironment">;
    readonly plugins: Pick<PluginBbSdk["plugins"], "callRpc">;
  };
}

export interface CloudLaunchCheckOptions {
  rules?: CloudLoginRules;
  poolTimeoutMs?: number;
}

const poolAccountSchema = z.looseObject({
  provider: z.string(),
  enabled: z.boolean(),
  status: z.string().optional(),
  error: z.string().nullable().optional(),
});
const poolStatusSchema = z.looseObject({
  routing: z.record(z.string(), z.boolean()),
  accounts: z.array(poolAccountSchema),
});

function findPoolStatus(value: unknown, depth = 0): z.output<typeof poolStatusSchema> | null {
  if (value === null || typeof value !== "object" || depth > 4) return null;
  const direct = poolStatusSchema.safeParse(value);
  if (direct.success) return direct.data;
  for (const child of Object.values(value)) {
    const found = findPoolStatus(child, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

export function targetsMachineProvider(context: MessageDispatchHookContext, machineProviderId: string): boolean {
  if (context.host?.machineProviderId === machineProviderId) return true;
  const intent = context.environmentIntent;
  return intent?.kind === "provider" && intent.machine.type === "new" && intent.machine.machineProviderId === machineProviderId;
}

export function createCloudLaunchCheck(
  bb: CloudLaunchApi,
  machineProviderId: string,
  options: CloudLaunchCheckOptions = {},
): (context: MessageDispatchHookContext) => Promise<MessageDispatchHookDecision> {
  const rules = options.rules ?? DEFAULT_CLOUD_LOGIN_RULES;
  const poolTimeoutMs = options.poolTimeoutMs ?? 3_000;

  async function readPool(): Promise<CloudLoginFacts["pool"]> {
    try {
      const status = findPoolStatus(
        await bb.sdk.plugins.callRpc({
          pluginId: ACCOUNT_POOL_PLUGIN,
          method: ACCOUNT_POOL_STATUS_METHOD,
          input: null,
          outputSchema: z.unknown(),
          signal: AbortSignal.timeout(poolTimeoutMs),
        }),
      );
      if (status === null) return null;
      const usableProviders = status.accounts
        .filter(
          (account) =>
            account.enabled &&
            (account.error ?? null) === null &&
            account.status !== "disabled" &&
            account.status !== "error",
        )
        .map((account) => account.provider);
      return { routing: status.routing, usableProviders: [...new Set(usableProviders)] };
    } catch {
      return null;
    }
  }

  return async (context) => {
    if (context.attempt === "join-turn" || !targetsMachineProvider(context, machineProviderId)) {
      return { action: "proceed" };
    }
    const providerId = context.requestedExecution.providerId;
    try {
      const env = await bb.sdk.projects.machineEnvironment({ projectId: context.project.id });
      const base = {
        envNames: [...new Set([...env.inheritedVariables, ...env.variables].map((variable) => variable.name))],
        builtInGit: env.builtInGit.status === "logged in" || env.builtInGit.status === "overridden",
      };
      const rule = cloudLoginRuleFor(providerId, rules);
      const pool = rule !== null && ruleNeedsPool(rule, base) ? await readPool() : null;
      const verdict = evaluateCloudLogin(providerId, { ...base, pool }, rules);
      return verdict.ok ? { action: "proceed" } : { action: "reject", message: verdict.message };
    } catch (error) {
      const text = redactSecrets(error instanceof Error ? error.message : String(error));
      return {
        action: "reject",
        message: `Cloud thread blocked: could not check cloud logins for ${providerId} (${text}). Retry, or start the thread locally.`,
      };
    }
  };
}
