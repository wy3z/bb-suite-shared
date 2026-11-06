# bb-suite

Shared pieces for the wy3z BB plugin suite (agent-pills, pull-requests,
cursor-sidebar, projects): RPC contracts and plugin ids, time formatting, and
design tokens. Plugins depend on it as `"@wy3z/bb-suite": "file:../bb-suite-shared"`
and `bb plugin build` bundles it.

- `@wy3z/bb-suite/contracts`: the Tasks plugin subset the suite reads, BB's git
  status read, the git actions served by pull-requests (commit, push, create
  PR, apply locally) and the Projects plugin's meta and leads.
- `@wy3z/bb-suite/time`: `shortAge` ("now", "5m", "3d", "2w", "1mo"),
  `duration` ("2h 5m") and `elapsed`.
- `@wy3z/bb-suite/tokens.css`: the suite palette (`--bbs-*`) and pill metrics.

Each plugin's tsconfig maps `@get-bb/plugin-sdk` and `zod` to its own copy, so
shared files type-check against the same SDK as the plugin.
