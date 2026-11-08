# bb-suite

Shared pieces for the wy3z BB plugin suite (agent-pills, pull-requests,
cursor-sidebar, projects): RPC contracts and plugin ids, time formatting, and
design tokens. Plugins depend on it as `"@wy3z/bb-suite": "file:../bb-suite-shared"`
and `bb plugin build` bundles it.

- `@wy3z/bb-suite/contracts`: the Tasks plugin subset the suite reads, BB's git
  status read, the git actions served by pull-requests (commit, push, create
  PR, apply locally) and the Projects plugin's meta and leads.
- `@wy3z/bb-suite/change-requests`: the provider-neutral change request read
  served by pull-requests (`changeRequests`, keyed by environment id) for GitHub
  pull requests and GitLab merge requests, its labels (`#12`, `!12`) and the
  `bb-pull-requests:open` event detail. Frontend-safe: zod only, no SDK import.
- `@wy3z/bb-suite/machine-backend`: the sandbox policy (`idleMinutes` 15,
  `ttlMinutes` 120, `maxConcurrent` 2, `monthlyCapUsd` 30, `hourlyRateUsd`,
  orphan handling), the machine resource schema, cap and concurrency refusal
  messages, `findSecretLike` and `redactSecrets`. Frontend-safe: zod only.
- `@wy3z/bb-suite/machine-backend/server`: `registerSandboxBackend(bb, backend,
  policy)` for vendor machine plugins. The vendor supplies only `create`,
  `exec`, `snapshot`, `stop`, `resume`, `remove`, `listByName` and optional
  `extendTtl`. `snapshot` must return only once the saved state is durable
  (`snapshotId: null` means the compute keeps its state across `stop`, in
  which case `stop` returns the surviving sandbox id). The helper registers
  the machine provider: an idempotent create keyed by name, with a checkpoint
  before allocating and core bootstrap over the vendor exec, plus a systemd
  probe. Suspend checkpoints the snapshot before stopping, stops every
  allocation under the name, and verifies none is still running. Resume
  re-runs bootstrap, then `remove` and `reconcileCleanup` complete the
  provider. Create and resume are admitted one at a time, with slot
  reservations against the concurrency and spend caps.
  It also registers the composed `project-checkout` environment and runs a
  minute sweep. The sweep suspends idle machines and extends the vendor TTL
  while a machine is active and under budget. Once the monthly cap is reached
  it stops renewing and asks core to suspend every running sandbox, so spend
  can overshoot by at most one sweep interval plus core's suspend time per
  running sandbox. It also removes orphaned allocations, but only after a
  complete ownership read and a grace period counted from when the allocation
  was first seen without an owner. Vendor progress, availability and validate
  messages are redacted. Exec output is passed to core unchanged because core
  parses installer output.
  It also installs a `message.dispatch` hook for its own sandboxes only that
  rejects a launch when the thread's agent has no cloud login. The check
  reads machine env names, never values, plus Account Pooler routing
  (`status.get`: `routing`, `accounts[].provider/enabled/status/error`). The
  rules are data (`DEFAULT_CLOUD_LOGIN_RULES`, `evaluateCloudLogin`) in the
  frontend-safe module, so vendors share them. Pass `launchCheck: { rules }`
  to extend them, or `launchCheck: false` and compose
  `createCloudLaunchCheck` into a plugin's own hook. Server-only.
- `@wy3z/bb-suite/time`: `shortAge` ("now", "5m", "3d", "2w", "1mo"),
  `duration` ("2h 5m") and `elapsed`.
- `@wy3z/bb-suite/tokens.css`: the suite palette (`--bbs-*`) and pill metrics.

Each plugin's tsconfig maps `@get-bb/plugin-sdk` and `zod` to its own copy, so
shared files type-check against the same SDK as the plugin.
