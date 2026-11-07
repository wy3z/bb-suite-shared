import { z } from "zod";

export const CHANGE_REQUESTS_PLUGIN = "pull-requests";
export const CHANGE_REQUESTS_METHOD = "changeRequests";
export const OPEN_CHANGE_REQUEST_EVENT = "bb-pull-requests:open";

export const CHANGE_REQUEST_PROVIDERS = ["github", "gitlab"] as const;
export type ChangeRequestProvider = (typeof CHANGE_REQUEST_PROVIDERS)[number];

export const CHANGE_REQUEST_STATES = ["open", "draft", "merged", "closed"] as const;
export type ChangeRequestState = (typeof CHANGE_REQUEST_STATES)[number];

export const CHANGE_REQUEST_CI_STATES = [
  "none",
  "pending",
  "passed",
  "failed",
  "canceled",
  "skipped",
  "manual",
  "unknown",
] as const;
export type ChangeRequestCiState = (typeof CHANGE_REQUEST_CI_STATES)[number];

export const CHANGE_REQUEST_UNAVAILABLE_REASONS = [
  "cliMissing",
  "authentication",
  "forbidden",
  "hostOffline",
  "notReady",
  "network",
  "rateLimited",
  "unsupportedHost",
  "ambiguous",
  "providerUnavailable",
  "unknown",
] as const;
export type ChangeRequestUnavailableReason = (typeof CHANGE_REQUEST_UNAVAILABLE_REASONS)[number];

const providerSchema = z.enum(CHANGE_REQUEST_PROVIDERS);

export const githubIdentitySchema = z.object({
  provider: z.literal("github"),
  instance: z.literal("https://github.com"),
  projectPath: z.string().min(3),
  number: z.number().int().positive(),
  url: z.string().min(1),
});

export const gitlabIdentitySchema = z.object({
  provider: z.literal("gitlab"),
  instance: z.string().min(1),
  projectPath: z.string().min(3),
  number: z.number().int().positive(),
  url: z.string().min(1),
  projectId: z.number().int().positive().nullable(),
});

export const changeRequestIdentitySchema = z.discriminatedUnion("provider", [
  githubIdentitySchema,
  gitlabIdentitySchema,
]);
export type GitHubIdentity = z.infer<typeof githubIdentitySchema>;
export type GitLabIdentity = z.infer<typeof gitlabIdentitySchema>;
export type ChangeRequestIdentity = z.infer<typeof changeRequestIdentitySchema>;

export const changeRequestSchema = z.object({
  identity: changeRequestIdentitySchema,
  title: z.string(),
  state: z.enum(CHANGE_REQUEST_STATES),
  ci: z.object({ state: z.enum(CHANGE_REQUEST_CI_STATES).catch("unknown") }),
  sourceBranch: z.string().nullable(),
  targetBranch: z.string().nullable(),
  updatedAt: z.string().nullable(),
  fetchedAt: z.string(),
  connection: z.string().nullable(),
});
export type ChangeRequest = z.infer<typeof changeRequestSchema>;

const unrecognisedRow = {
  outcome: "unavailable" as const,
  provider: null,
  reason: "unknown" as const,
  message: "This change request row isn't in a format this plugin understands.",
};

export const changeRequestRowSchema = z
  .discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("available"), changeRequest: changeRequestSchema }),
    z.object({ outcome: z.literal("absent"), provider: providerSchema.nullable().catch(null) }),
    z.object({
      outcome: z.literal("unavailable"),
      provider: providerSchema.nullable().catch(null),
      reason: z.enum(CHANGE_REQUEST_UNAVAILABLE_REASONS).catch("unknown"),
      message: z.string(),
      candidates: z.number().int().nonnegative().optional(),
    }),
  ])
  .catch(unrecognisedRow);
export type ChangeRequestRow = z.infer<typeof changeRequestRowSchema>;

export const CHANGE_REQUEST_KEY_LIMIT = 200;

export function environmentChangeRequestTag(environmentId: string): string {
  return `environment:${environmentId}`;
}

export const changeRequestsContract = {
  changeRequests: {
    experimental_description:
      "The pull or merge request for each environment's current branch, keyed by environment id, for GitHub and GitLab.",
    input: z.object({ keys: z.array(z.string().min(1).max(200)).max(CHANGE_REQUEST_KEY_LIMIT) }),
    output: z.record(z.string(), changeRequestRowSchema),
    keyTags: (key: string) => [environmentChangeRequestTag(key)],
  },
} as const;

export function rowProvider(row: ChangeRequestRow | undefined): ChangeRequestProvider | null {
  if (row === undefined) return null;
  return row.outcome === "available" ? row.changeRequest.identity.provider : row.provider;
}

export function changeRequestLabel(identity: Pick<ChangeRequestIdentity, "provider" | "number">): string {
  return `${identity.provider === "gitlab" ? "!" : "#"}${identity.number}`;
}

export function changeRequestNoun(provider: ChangeRequestProvider): string {
  return provider === "gitlab" ? "merge request" : "pull request";
}

export function changeRequestKey(identity: Pick<ChangeRequestIdentity, "provider" | "instance" | "projectPath" | "number">): string {
  return `${identity.provider}:${identity.instance}/${identity.projectPath}${changeRequestLabel(identity)}`;
}

export interface OpenChangeRequestDetail {
  url: string;
  connection?: string;
  threadId?: string;
}

export function openChangeRequestDetail(detail: unknown): OpenChangeRequestDetail | null {
  if (typeof detail !== "object" || detail === null) return null;
  const { url, connection, threadId } = detail as Record<string, unknown>;
  if (typeof url !== "string" || url.length === 0 || url.length > 500) return null;
  return {
    url,
    ...(typeof connection === "string" && connection.length > 0 && connection.length <= 200 ? { connection } : {}),
    ...(typeof threadId === "string" && /^thr_[A-Za-z0-9]{1,64}$/.test(threadId) ? { threadId } : {}),
  };
}
