# intervu

## 0.2.0

### Minor Changes

- e8d5ee3: Make live-reload reliable: the browser no longer misses edits when its connection drops, and artifacts inside large repos no longer trigger a recursive file watch. Add `intervu reply <file> <message>` so the agent can post into the conversation without waiting, and teach the Skill to explore the codebase during a review while a poll keeps listening. Keep the scroll position across live-reloads, fix `intervu <file>` failing when it had to start the daemon, and teach the Skill to show a skeleton early, keep a reusable brief, and make targeted edits. Re-run `intervu setup` to pick up the updated Skill.
- c30dc03: `intervu poll` now writes each DOM snapshot to a file and prints `domSnapshotPath` instead of the whole page, so long reviews use far less of the agent's context. It falls back to the inline `domSnapshot` if the file cannot be written. Re-run `intervu setup` to pick up the updated Skill.

## 0.1.1

### Patch Changes

- bbe9680: Fix `intervu setup` wiring a skill and session-start hook that could not run.
  Both invoke a bare `intervu`, which only resolves after a global install, so users who ran the loop via `bunx intervu` got artifacts pointing at a command that was not on their `PATH`.
  Setup now resolves `intervu` on `PATH` before writing anything and refuses with a clear `bun add -g intervu` message instead of silently wiring a broken loop (ADR 0019).

## 0.1.0

### Minor Changes

- 06c4a34: First published release: intervu ships as an installable npm package - run `bunx intervu <file>` (or `bun add -g intervu`) on any machine with Bun - with releases automated via Changesets.
