import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const TASKS_PLUGIN = "tasks";
export const PULL_REQUESTS_PLUGIN = "pull-requests";
export const PROJECTS_PLUGIN = "projects";
export const CURSOR_SIDEBAR_PLUGIN = "cursor-sidebar";
export const GIT_PLUGIN = "bb--git";

export const STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const;
export type Status = (typeof STATUSES)[number];
export const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
export type Priority = (typeof PRIORITIES)[number];

const projectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    prefix: z.string(),
    color: z.string(),
    linkedBbProjectId: z.string().nullable(),
  })
  .passthrough();
export type Project = z.infer<typeof projectSchema>;

const taskSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    key: z.string(),
    title: z.string(),
    description: z.string(),
    status: z.enum(STATUSES),
    priority: z.enum(PRIORITIES),
    parentTaskId: z.string().nullable(),
    position: z.number(),
    labelIds: z.array(z.string()),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();
export type Task = z.infer<typeof taskSchema>;

const labelSchema = z.object({ id: z.string(), name: z.string(), color: z.string() }).passthrough();
export type Label = z.infer<typeof labelSchema>;

const taskThreadSchema = z
  .object({
    threadId: z.string(),
    presetName: z.string(),
    title: z.string(),
    liveStatus: z.enum(["starting", "working", "idle", "completed", "failed"]),
    attachedAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();
export type TaskThread = z.infer<typeof taskThreadSchema>;

const pullRequestSchema = z
  .object({
    url: z.string(),
    number: z.number(),
    title: z.string(),
    state: z.enum(["open", "draft", "merged", "closed"]),
    threadIds: z.array(z.string()),
  })
  .passthrough();
export type PullRequest = z.infer<typeof pullRequestSchema>;

const presetSchema = z
  .object({ id: z.string(), name: z.string(), providerId: z.string(), modelId: z.string(), environmentKind: z.string() })
  .passthrough();
export type Preset = z.infer<typeof presetSchema>;

const mutationSchema = z.union([
  z.object({ ok: z.literal(true), task: taskSchema }).passthrough(),
  z.object({ ok: z.literal(false), error: z.object({ message: z.string() }).passthrough() }).passthrough(),
]);

const taskTag = (taskId: string) => `task:${taskId}`;
const projectTasksTag = (projectId: string) => `tasks:${projectId}`;

export const tasksContract = defineRpcContract({
  listProjects: {
    tags: () => ["projects"],
    input: z.object({}).strict(),
    output: z.object({ projects: z.array(projectSchema) }).passthrough(),
  },
  listAllTasks: {
    tags: (input: { projectId: string }) => [projectTasksTag(input.projectId)],
    input: z.object({ projectId: z.string() }).strict(),
    output: z.object({ tasks: z.array(taskSchema) }).passthrough(),
  },
  listLabels: {
    tags: (input: { projectId: string }) => [`labels:${input.projectId}`],
    input: z.object({ projectId: z.string() }).strict(),
    output: z.object({ labels: z.array(labelSchema) }).passthrough(),
  },
  listTaskCardMeta: {
    tags: () => ["task-meta"],
    input: z.object({ projectId: z.string() }).strict(),
    output: z
      .object({
        cards: z.array(
          z.object({ taskId: z.string(), attachmentCount: z.number(), activeThreads: z.array(taskThreadSchema) }).passthrough(),
        ),
      })
      .passthrough(),
  },
  listTaskThreads: {
    tags: (input: { taskId: string }) => [`threads:${input.taskId}`],
    input: z.object({ taskId: z.string() }).strict(),
    output: z.object({ taskThreads: z.array(taskThreadSchema) }).passthrough(),
  },
  listTaskPullRequests: {
    tags: (input: { taskId: string }) => [`threads:${input.taskId}`, `pull-requests:${input.taskId}`],
    input: z.object({ taskId: z.string() }).strict(),
    output: z.object({ pullRequests: z.array(pullRequestSchema) }).passthrough(),
  },
  listPresets: {
    tags: () => ["presets"],
    input: z.null(),
    output: z.object({ presets: z.array(presetSchema) }).passthrough(),
  },
  boardMove: {
    input: z
      .object({
        taskId: z.string(),
        status: z.enum(STATUSES),
        beforeTaskId: z.string().nullable().optional(),
        afterTaskId: z.string().nullable().optional(),
      })
      .strict(),
    output: mutationSchema,
  },
  listComments: {
    tags: (input: { taskId: string }) => [`comments:${input.taskId}`],
    input: z.object({ taskId: z.string() }).strict(),
    output: z
      .object({
        comments: z.array(
          z
            .object({
              id: z.string(),
              kind: z.enum(["user", "agent", "system"]),
              authorName: z.string(),
              body: z.string(),
              createdAt: z.string(),
              threadId: z.string().nullable(),
              threadTitle: z.string().nullable().optional(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  },
  updateTask: {
    input: z
      .object({ taskId: z.string(), status: z.enum(STATUSES).optional(), priority: z.enum(PRIORITIES).optional() })
      .strict(),
    output: mutationSchema,
  },
  delegate: {
    input: z.object({ taskId: z.string(), presetId: z.string(), extraInstructions: z.string().optional() }).strict(),
    output: z.object({ threadId: z.string() }).passthrough(),
  },
});

export { taskTag };

const statsSchema = z.object({ insertions: z.number(), deletions: z.number(), fileCount: z.number() }).passthrough();

export const gitStatusSchema = z
  .object({
    outcome: z.literal("available"),
    workspace: z
      .object({
        workingTree: statsSchema,
        mergeBase: statsSchema.nullish(),
      })
      .passthrough(),
  })
  .passthrough();

export const gitContract = defineRpcContract({
  status: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(z.string(), z.unknown()),
  },
});

const environmentIdSchema = z.string().trim().min(1).max(200);

const gitActionResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  sha: z.string().optional(),
  subject: z.string().optional(),
  branch: z.string().optional(),
  url: z.string().optional(),
  existed: z.boolean().optional(),
  files: z.number().optional(),
});

export type GitActionResult = z.infer<typeof gitActionResultSchema>;

export const gitActionsContract = defineRpcContract({
  gitCommit: {
    input: z.object({
      environmentId: environmentIdSchema,
      message: z.string().max(20_000),
      push: z.boolean(),
      includeUntracked: z.boolean().default(false),
    }),
    output: gitActionResultSchema,
  },
  gitPush: {
    input: z.object({ environmentId: environmentIdSchema }),
    output: gitActionResultSchema,
  },
  gitCreatePullRequest: {
    input: z.object({ environmentId: environmentIdSchema }),
    output: gitActionResultSchema,
  },
  gitApplyLocally: {
    input: z.object({
      sourceEnvironmentId: environmentIdSchema,
      targetEnvironmentId: environmentIdSchema,
    }),
    output: gitActionResultSchema,
  },
});

export const META_CHANGED = "project-meta";

const metaSchema = z.object({
  focus: z.string().nullable(),
  focusUpdatedAt: z.string().nullable(),
  leadThreadId: z.string().nullable(),
});
export type ProjectMeta = z.infer<typeof metaSchema>;

const projectIdSchema = z.string().trim().min(1).max(100);

export const projectsContract = defineRpcContract({
  getMeta: {
    tags: (input: { projectId: string }) => [`meta:${input.projectId}`],
    input: z.object({ projectId: projectIdSchema }),
    output: metaSchema,
  },
  setFocus: {
    input: z.object({ projectId: projectIdSchema, focus: z.string().max(600).nullable() }),
    output: metaSchema,
  },
  listLeads: {
    tags: () => ["leads"],
    input: z.object({}),
    output: z.object({ leads: z.array(z.object({ projectId: z.string(), threadId: z.string(), focus: z.string().nullable() })) }),
  },
  setLead: {
    input: z.object({ projectId: projectIdSchema, threadId: z.string().startsWith("thr_").nullable() }),
    output: metaSchema,
  },
});
