# intervu

## 0.3.1

### Patch Changes

- 3496d96: URL mode works behind a reverse proxy that terminates TLS: the relay keys the page by the browser's own origin, checks `Origin` against the dev server's trusted hosts and forwarded headers, and logs why it refused a request. `intervu <https url>` accepts a dev certificate from a local CA and checks that the plugin sees the Session it opened. A Feedback whose page snapshot a proxy refuses still delivers the note, and the panel shows why a send failed. The snapshot drops scripts, styles, inline SVG paths and `data:` payloads. Annotation sources name the line as written when the React Compiler rewrites a component, and a click inside a third-party component names the app's call of that component.

## 0.3.0

### Minor Changes

- 803839a: Review a running Vite + React app, not just an HTML file: add `intervu()` from `intervu/vite` to the app's Vite plugins, then `intervu <url>` opens a floating panel in the app's own tab. Annotations carry the JSX `file:line:col` that rendered the clicked element, so the agent edits the right file. `poll`, `reply` and `end` take the URL as well as a file, and the Conversation stays live across tabs, HMR and full reloads. The plugin runs on the dev server only and answers only the app's own origin. Re-run `intervu setup` to pick up the updated Skill.

## 0.2.1

### Patch Changes

- db79f5b: Report the real version from `intervu --version` and the daemon's health check instead of `0.0.0`, so upgrading replaces a running older daemon automatically.

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
