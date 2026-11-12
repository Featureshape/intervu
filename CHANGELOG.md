# intervu

## 0.4.0

### Minor Changes

- e0a289c: `intervu doctor <url>` replays the overlay's exact Session lookup - same path, same `?origin=`, same Origin header, so the false pass a bare `curl` gives cannot happen - and prints a per-check verdict: app reachable, plugin answering, guard verdict with the rejection reason on a refusal, daemon reachable from the plugin, and whether an open Session matches the origin. Every failing check carries a fix hint and the run exits non-zero. The README gains a "Behind a reverse proxy" section with working nginx and Caddy blocks (forward Host with its port, set X-Forwarded-Proto, buffering off, body limit up), and the Skill's troubleshooting now points at `intervu doctor` and `intervu status` as the first moves.
- 8b5362d: The last three sandbox frictions die. When the resolved state dir is not writable (a sandboxed `~/.local/state`), intervu falls back to `$TMPDIR/intervu-<user>` and says so, and `intervu status` names the state dir in use. A `poll` whose connection drops without a decoded response re-issues itself silently against the same handle, preserving any remaining `--timeout` budget, and fails with a structured error only when the daemon stops answering `/health` - no more hand-rolled `--timeout 240` loops. And `intervu setup vite` writes the bundled dependency-free ESM plugin to `<project>/.intervu/vite.mjs` with no package manager and no network, printing the exact import line and config edit; it is idempotent and never edits `vite.config.ts` itself.
- 0b13830: Owner-configured redaction makes URL-mode reviews safe on apps with personal data. Markup under `data-intervu-redact` is masked in every snapshot and annotation, regardless of configuration. With `intervu({ redact: true })` in the Vite config the whole page masks: every text node and the `value`, `placeholder`, `alt`, `title` and `aria-label` attributes are replaced per character (letters to `x`, digits to `0`), preserving length, whitespace and DOM structure, so selectors, ids and `data-intervu-src` still resolve. Masking happens in the browser before anything leaves the page, and nothing the agent or the CLI sends can turn it off; the human's typed message is never redacted, and `poll` marks a Feedback whose snapshot was redacted so the agent knows the placeholders are deliberate.
- 52090e6: The agent can now see what the browser side sees without a human relaying the tab. The `intervu/vite` plugin pushes plugin-reports to the local daemon over loopback - its dev server's origin, the page origins it has seen succeed, and refusal tallies - on dev server start, every 30s while tabs hold relay connections, and promptly after a refusal. The new `intervu status` asks the live daemon and prints its version, port and state dir, every Session with its Presence, the reporting plugins and their refusal tallies; bare `intervu` stays offline. When `intervu <url>`'s probe cannot reach the app but the daemon holds a fresh plugin-report covering that origin, the help line says what the plugin reported instead of the false "plugin missing" warning. Reports live in daemon memory only; an old daemon ignores them and an old plugin keeps working untouched.
- ffa9512: Sessions expire and daemons coexist. Every Session persists `lastActivityAt` - bumped by open, feedback, poll, reply and end - and one idle past the TTL (default 24h, `INTERVU_SESSION_TTL` in seconds) counts as `ended`: the Home view omits it, the daemon sweeps on start and hourly, and re-opening the handle resurrects it. State files from older versions load with the field defaulted to the load time, so nothing expires on the first read after an upgrade. The fixed port 51789 becomes the range 51789-51798: a daemon binds the first free port, `/health` names its state dir and instance id, a client finding a stranger's daemon on a port leaves it alone and remembers where its own daemon bound, and the Vite plugin fans its lookups and reports out across the whole range - when two daemons hold an open Session for one origin, the relay uses the most recently active and logs a warning naming both ports. An explicit `INTERVU_PORT` pins everything to exactly that port, with no range scan.

### Patch Changes

- ba3cc45: The in-page badge tells the truth about why no review is running. When the relay refuses the page's request, the badge reads "intervu: refused by dev server" and its card names the rejection in plain words, echoes the page origin the browser sent, and points at the dev server log for the full comparison. When no daemon answers behind the dev server, the badge's card says so and names the port it tried, beside the open command. The 403 body now carries the rejection reason and the origins the refused request itself presented - never the server's trusted-host list.
- c5b9395: `intervu <url>` warns when the origin is one no browser will ever report - `http:` with explicit port 443 or `https:` with explicit port 80 - naming the origin a browser would actually report; the Session still opens. The daemon now remembers each origin whose Session lookup found nothing (count and last-seen, in memory only), `intervu status` lists those waiting origins, and opening a different origin while a browser is waiting prints "a browser at `<origin>` is looking for a session - did you mean `intervu <origin>`?".

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
