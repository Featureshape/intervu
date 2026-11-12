# Spec: review loop operability (intervu tells the truth about itself)

## Problem

Reviewing a real app behind a TLS-terminating nginx proxy, with the agent in a sandbox, cost most of a day to friction that was not the review loop itself.
It was intervu being silent or wrong about its own state.

- The relay refused the browser with a 403 and knew the exact reason (`foreign-page-origin`, with the Origin and page origin it saw), but the panel showed only "intervu: no agent" and retried every second.
- The agent was blind: its sandbox cannot reach the app's public origin, so the human had to keep relaying what the tab showed.
  The plugin can always reach the daemon on loopback, but it never reports anything to it.
- The CLI accepted `http://host:443`, an origin no browser will ever report, and opened a Session no page could find.
  The daemon saw the real browser's lookups miss the whole time and remembered none of them.
- The working reverse-proxy recipe lives only in one person's notes, and a plain `curl` without `?origin=` gave a false pass that misled the debugging once.
- Snapshots carry the full page, so on an app with customer data the agent must skip any page with PII, which reduces the loop to annotations without page context.
- Three Sessions from dead agent sessions are still listed as `open` at every startup, and two live agents on one machine would fight over the fixed port 51789.
- Inside the sandbox `~/.local/state` is not writable, so every run needs an `XDG_STATE_HOME` workaround, and every agent loops `poll --timeout 240` by hand to survive a roughly 300s connection drop.

## Solution

Make every failure that intervu already knows about visible at the surface where someone can act on it.
The in-page badge names the refusal it got.
The plugin reports its sightings and refusals to every local daemon, and a new `intervu status` shows them to the agent.
The CLI warns about origins no browser will report, remembers browsers that are looking for a Session, and a new `intervu doctor <url>` replays the overlay's exact request and prints the guard's verdict.
A documented reverse-proxy recipe replaces the private notes.
Owner-configured redaction makes snapshots safe on apps with personal data.
Sessions expire after sustained inactivity, daemons from different agent sandboxes coexist on a small port range, the state dir falls back to a writable place, and `poll` survives connection drops on its own.

## Current state

All references are to the working tree at `3496d96`.

- **Relay guard.**
  `guardRequest` knows four rejection codes - `foreign-host`, `cross-site-fetch`, `foreign-origin`, `foreign-page-origin` (`src/vite/relay.ts:69-73`, `:190-229`).
  A refusal returns `sendError(response, 403, "ForeignOrigin", ...)` whose body carries only the code, not the origins compared (`src/vite/plugin.ts:58-77`).
  The dev server log gets a full line with the Host, Origin, page origin, `Sec-Fetch-Site` and forwarded headers, deduped and capped at 50 distinct messages (`src/vite/relay.ts:247-265`, `src/vite/plugin.ts:142-159`).
- **Badge.**
  `lookupOpenSession` returns `null` for any non-ok response and any thrown error, so a 403, a 404 and a network error all render as "intervu: no agent" (`src/overlay/entry.ts:445-452`, `:472-522`).
  The relay itself answers `200 {session:null}` when the daemon is down or slow (`src/vite/relay.ts:458-540`), so the page cannot tell "no daemon" from "no Session" either.
  The lookup retries every 1s with no backoff (`src/overlay/entry.ts:436`, `:458-469`).
- **Plugin to daemon.**
  The plugin never pushes anything: no heartbeat, no refusal report.
  Everything it sends is a relayed page request - `GET /apps/session?origin=` for lookups (`src/vite/plugin.ts:95-98`, `src/DaemonRoutes.ts:9-13`), plus the feedback and SSE routes for the open key (`src/vite/relay.ts:273-279`, `:548-575`).
  It finds the daemon via `daemonPortFrom(process.env.INTERVU_PORT)` with default 51789, always on `127.0.0.1` (`src/vite/plugin.ts:49`, `src/DaemonPort.ts:8`, `src/vite/relay.ts:422`).
- **CLI URL mode.**
  `parseAppUrl` accepts any absolute http(s) URL and never checks scheme against port, so `http://host:443` passes through as-is (`src/AppUrl.ts:20-26`).
  The Session key is 16 hex chars of SHA-256 of the origin string (`src/SessionStore.ts:90-101`, ADR 0022).
  The plugin probe classifies `sees-session`, `other-session`, `refused`, `missing` (`src/AppProbe.ts:65-111`) and feeds the help line (`src/main.ts:154-169`); a probe the proxy blocks reads as `missing`, which is the false "plugin missing" warning.
- **No status, no doctor.**
  The subcommands are `open, poll, reply, end, server, stop, setup` (`src/main.ts:494-512`).
  Bare `intervu` reads `state.json` offline and lists `open` Sessions (`src/main.ts:53-75`, ADR 0013).
  `GET /apps/session` neither logs nor stores a miss (`src/Server.ts:132-159`); nothing records that a browser asked for an origin and found nothing.
- **Snapshots.**
  URL-mode snapshots strip intervu's own elements and run `trimSnapshot` (scripts, styles, svg bodies, data: URIs) but keep all text and attribute values (`src/overlay/entry.ts:699-706`, `src/overlay/snapshot.ts:32-53`).
  There is no redaction of any kind, and annotations carry element text verbatim (`src/Protocol.ts`).
- **Persistence and staleness.**
  State resolves `INTERVU_STATE_DIR`, then `$XDG_STATE_HOME/intervu`, then `~/.local/state/intervu`, with no fallback when that is unwritable (`src/AppConfig.ts:57-58`, `:76-83`).
  A Session is `{key, path, status, kind}` with no timestamp of any kind (`src/Session.ts:37-42`); nothing expires, and idle shutdown never ends Sessions (`src/IdleShutdown.ts:24-25`).
- **Port.**
  51789 is the single fixed default (`src/DaemonPort.ts:8`); the only collision handling is the stale-version takeover (`src/ServerLifecycle.ts:268-304`, ADR 0015).
  A same-version daemon from another agent's sandbox is reused as if it were one's own, and two live daemons cannot coexist.
  `/health` names the version but not whose daemon it is.
- **Poll.**
  The server-side wait is unbounded, the server heartbeat never writes to the wire, and the client has no response timeout and no retry (`src/FeedbackWait.ts:35`, `:102-119`, `src/ServerLifecycle.ts:331-360`).
  A dropped connection kills the poll, which is why agents loop `--timeout 240`; the Skill tells them to re-run (`src/skill/SKILL.md:171`).
- **Setup and docs.**
  `intervu setup` writes only the Skill and the Hook (`src/Setup.ts:95-173`); installing the Vite plugin is a manual step described in the Skill (`src/skill/SKILL.md:50-68`).
  README has no URL-mode section and nothing about proxies; proxy knowledge is scattered across ADR 0023, the Skill's troubleshooting list and the relay's reason strings.
- **Already fixed at HEAD, not re-specified here.**
  Source lines under the React Compiler (`e2e/react-compiler-source.spec.ts`) and clicks inside third-party components (`e2e/third-party-portal-source.spec.ts`) are covered by passing e2e specs and the pending `.changeset/proxy-origin-and-source-lines.md`.

## Behaviour

### The badge tells the truth

1. With the dev server up and no daemon reachable from the plugin, the badge reads "intervu: no agent" and its card says no daemon answered on the port(s) it tried, beside the `intervu <origin>` command.
2. With a daemon up and no Session for the origin, the badge reads "intervu: no agent" and its card says an agent can open one, with the command (today's behaviour, now meaning exactly this case).
3. When the relay refuses the page's request, the badge reads "intervu: refused by dev server" and its card names the rejection reason in plain words (for `foreign-page-origin`: "page origin doesn't match what the dev server trusts"), echoes the page origin the browser sent, and points at the dev server log for the full comparison.
4. The 403 body gains the rejection reason and the request's own presented origins (Origin header, page origin); it never includes the server's trusted-host list.
5. The dev server log line stays as it is.

### The plugin reports to the daemon

6. The plugin sends a plugin-report to every live local daemon: on dev server start, every 30s while any tab holds a relay connection, and promptly after a refusal.
   A report carries the dev server's own origin, the page origins it has seen succeed, and a tally of refusals `{reason, origin, pageOrigin, count, lastAt}`.
7. The daemon keeps plugin-reports and Session-lookup misses in memory only; a daemon restart starts clean.
8. `intervu status` is a new subcommand that asks the live daemon(s) and prints as TOON: daemon version, port and state dir; each Session with kind, handle, status, Presence and last activity; each reporting plugin with its origin and last-seen time; refusal tallies; and waiting origins (behaviour 12).
9. When `intervu <url>`'s probe says `missing` or `refused` but a daemon holds a fresh plugin-report whose seen origins include the target, the help line reports what the plugin reported instead of the false "plugin missing" warning.

### Picking the right origin

10. `intervu <url>` warns on `http:` with explicit port 443 and on `https:` with explicit port 80, suggesting the origin a browser would actually report; the Session still opens.
11. The daemon remembers each origin whose `/apps/session` lookup found no Session, with last-seen time and count.
12. `intervu <url>` whose origin matches no waiting origin, while some other origin is waiting, prints a help line: "a browser at `<waiting origin>` is looking for a session - did you mean `intervu <waiting origin>`?".
13. `intervu status` lists waiting origins.

### Doctor and docs

14. `intervu doctor <url>` replays the overlay's exact lookup - `GET <url origin>/__intervu/session?origin=<origin>` with the Origin header set - and prints a per-check TOON verdict: app reachable, plugin answering, guard verdict (with the rejection reason on refusal), daemon reachable from the plugin, and whether an open Session matches the origin.
15. `doctor` exits non-zero when any check fails, and each failing check carries a fix hint.
16. A plain request without `?origin=` is never what doctor sends, so the false pass that a bare `curl` gives cannot happen through it.
17. README gains a "Behind a reverse proxy" section with working nginx and Caddy snippets - forward Host with its port, set `X-Forwarded-Proto`, disable response buffering, allow a large request body - and names `intervu doctor`.
18. The Skill's troubleshooting list points at `intervu doctor` and `intervu status` as the first moves.

### Snapshots safe for personal data

19. Any element under a `data-intervu-redact` attribute has its text and sensitive attributes masked in every snapshot and in annotation `text`/`selectedText`, regardless of configuration.
20. With `intervu({ redact: true })` in the Vite config, the whole page is masked: every text node and the `value`, `placeholder`, `alt`, `title` and `aria-label` attributes are replaced per character (letters to `x`, digits to `0`), preserving length, whitespace and DOM structure.
21. Masking never touches tags, ids, classes, selectors or `data-intervu-src`, so annotations still resolve and source mapping still works.
22. Redaction is applied in the browser before anything leaves the page, and it is the app owner's plugin config; nothing the agent or the CLI sends can turn it off.
23. The human's typed message is never redacted.
24. `poll` output marks a Feedback whose snapshot was redacted, so the agent knows the placeholders are deliberate.

### Sessions expire, daemons coexist

25. Every Session carries a persisted `lastActivityAt`, bumped by open, feedback, poll, reply and end.
26. A Session with no activity for the TTL (default 24h, `INTERVU_SESSION_TTL` in seconds) counts as `ended`: the Home view omits it, the daemon sweeps it on start and hourly, and re-opening the handle resurrects it as today.
27. `/health` gains the daemon's state dir and an instance id.
28. A client finding its port held by a live daemon with a different state dir does not reuse or evict it; the daemon binds the first free port in the fixed range 51789-51798, and the client persists the chosen port in its own state file so later commands in that agent session find it.
29. An explicit `INTERVU_PORT` pins both the CLI and the plugin to exactly that port, with no range scan.
30. The plugin probes the whole range: Session lookups ask every live daemon and use the one holding an open Session for the origin; plugin-reports go to all of them.
31. When two daemons both hold an open Session for one origin, the relay uses the one with the most recent activity and logs a warning naming both ports.
32. Two agents in two sandboxes, each with its own daemon, can review two different origins at the same time.

### Smaller hardening

33. When the resolved state dir is not writable, intervu falls back to `$TMPDIR/intervu-<user>` and says so; `intervu status` names the state dir in use.
34. A `poll` whose connection drops without a decoded response re-issues itself silently against the same handle, preserving any remaining `--timeout` budget; it fails with a structured error only when the daemon stops answering `/health`.
35. `intervu setup vite` writes the bundled dependency-free ESM plugin to `<project>/.intervu/vite.mjs` and prints the exact import line and config edit for `vite.config.ts`; it is idempotent and never edits the config itself.
36. Artifact mode and all existing URL-mode behaviours are unchanged.

## Decisions

- **Failures are classified at the relay, read by the badge.**
  `/__intervu/session` answers distinguish no-daemon from no-Session, and the 403 body carries the rejection reason; the overlay renders what it is told.
  Lost: parsing the dev server log from the page, because the page cannot read it.
  Lost: keeping all failures as one "no agent" state, because that is exactly today's silence.
- **Refusal detail echoes only what the caller sent.**
  The 403 body repeats the reason code and the origins the request itself presented; the trusted-host list appears only in the dev server log.
  Lost: a fully explanatory 403, because it would hand a genuinely foreign page the server's allowlist.
- **The plugin pushes; the daemon never scrapes.**
  Reports flow plugin-to-daemon over loopback, because the plugin always knows where the daemon is and the reverse is not true.
  Lost: the daemon probing dev servers, because it does not know their origins or ports.
- **Plugin-reports and waiting origins live in daemon memory.**
  They are diagnostics of the present, not state worth persisting.
  Lost: persisting them, because stale diagnostics would lie after a restart, which is the exact disease being treated.
- **`status` is a live command; the Home view stays offline.**
  Bare `intervu` keeps its zero-network read (ADR 0013); `intervu status` is the one that talks to daemons.
  Lost: enriching the Home view with live data, because the session-start Hook depends on it being fast and side-effect-free.
- **Waiting origins come from lookups that already happen.**
  The dormant badge polls every second through the relay, so the daemon only has to remember the misses.
  Lost: a new browser beacon, because the signal already arrives.
- **`doctor` replays the overlay's request byte-for-byte.**
  Same path, same `?origin=`, same Origin header, because a plain `curl` without them gave a false pass that cost real debugging time.
  Lost: documenting a curl recipe instead, because the recipe is exactly the thing people get subtly wrong.
- **Redaction is browser-side and owner-configured.**
  Masking happens in the overlay before send, switched by the app owner's plugin config plus the always-on attribute, so unmasked PII never leaves the page and no agent-side flag can bypass it.
  Lost: daemon-side redaction, because the PII would still transit and land in the snapshot file before masking.
  Lost: a CLI `--redact` flag as the switch, because the party that must be able to rely on it is the app owner, not the agent.
- **Masking preserves shape.**
  Per-character replacement keeps length, whitespace and structure, so layout, truncation and selector context stay reviewable.
  Lost: dropping text nodes, because it changes layout.
  Lost: a `[redacted]` token, because it destroys length classes.
- **Expiry is a TTL on persisted activity, computed wherever Sessions are read.**
  `lastActivityAt` lives in `state.json`, so the offline Home view filters expired Sessions itself and the daemon sweep merely tidies.
  Lost: daemon-only expiry, because the Home view and the session-start Hook read the file without a daemon.
  Lost: deleting expired Sessions, because `ended` plus resurrection is the established reversible shape (ADR 0012).
- **Coexistence is a small fixed port range plus daemon identity.**
  `/health` names the state dir, "mine" means "same state dir", and a stranger's live daemon is left alone while a new one binds the next port in 51789-51798.
  Lost: one shared daemon across agents, because a sandbox tearing down takes its children with it and would strand every other agent.
  Lost: a random free port, because the plugin could never find it.
  Lost: takeover of a same-version foreign daemon, because that is today's collision.
- **The plugin fans out across the range.**
  Lookups and reports go to every live port; ten loopback probes with short timeouts are cheap next to a 1s polling loop that already runs.
  Lost: the plugin picking one daemon, because it cannot know which agent the human is working with.
- **Poll resilience is client-side reconnect.**
  The poll response is a single TOON document, so the wire cannot carry keepalives; the CLI re-issues on transport failure instead.
  Lost: streaming keepalives inside the response, because it would break the single-response contract (ADR 0009).
- **`setup vite` extracts; it never edits build config.**
  The binary already carries its browser assets (ADR 0007), so it can write `.intervu/vite.mjs` with no package manager and no network; the config edit stays human, consistent with the live-app-review decision.
  Lost: writing into `node_modules`, because package managers blow it away without notice.
  Lost: editing `vite.config.ts`, for the reasons already decided in live-app-review.
- **Old and new halves degrade gracefully.**
  A new daemon ignores nothing it does not know; a new plugin treats a 404 on the report route as an old daemon and keeps relaying; a new badge treats an old relay's unclassified answer as today's "no agent".

## Seams

One seam: the Playwright E2E harness, extended.

- **Existing: the harness** boots the real daemon plus nine fixture dev-server instances, drives the CLI through `e2e/cli.ts`, and already covers the guard (`e2e/relay-origin.spec.ts`) and an nginx-like https proxy (`e2e/behind-proxy.spec.ts`, `e2e/httpsProxy.ts`).
  Badge classification, doctor verdicts, status output, waiting-origin hints and the proxy recipe are all browser, relay or CLI behaviours that only show up here.
- **New within it: a redaction fixture instance** - the fixture app served with `intervu({ redact: true })`, plus a page region under `data-intervu-redact` in the default instance.
- **New within it: a second-daemon fixture** - a spec that starts a second `bun src/main.ts server` with a different `INTERVU_STATE_DIR`, asserting the range bind, `/health` identity, and the relay finding Sessions on both.
- **New within it: a dropping proxy** - a TCP relay fixture that cuts idle connections after a few seconds, for the poll-reconnect spec.
- **New within it: a setup-vite spec** - a temp project where `intervu setup vite` runs twice and the written `.intervu/vite.mjs` loads in a Vite config.
- **Unit tests beside `tests/`** for the pure parts: the masking function, the scheme/port warning, TTL arithmetic, and the range-scan predicate.

## Sequence

1. The badge and the 403 body classify refusals; the proxy spec asserts the refused badge names the reason.
2. The plugin reports to the daemon and `intervu status` renders Sessions, plugins, refusals; the false "plugin missing" warning dies.
3. The scheme/port warning, waiting origins and the did-you-mean help line land.
4. `intervu doctor <url>` ships with the README reverse-proxy section and the Skill update.
5. Redaction: the attribute, the plugin flag, the masked annotations and the poll marker.
6. `lastActivityAt`, the TTL sweep, the port range and daemon identity; two daemons coexist in e2e.
7. The state-dir fallback, poll reconnect, and `intervu setup vite`.

Each step leaves the suite green and ships value alone; later steps lean on earlier ones only where `status` (2) displays what (3) records.

## Out of scope

- The two mapping bugs (React Compiler source lines, third-party component clicks): fixed at HEAD with e2e coverage.
- Redaction for artifact mode; artifacts are agent-generated and hold no customer data.
- Authentication, multi-user daemons, or any non-loopback exposure.
- Persisting plugin-reports or refusal history across daemon restarts.
- More than ten concurrent daemons on one machine.
- `setup vite` editing `vite.config.ts`.
- Next.js or any dev server other than Vite.

## Accepted breakage

- "The fixed port 51789" becomes "the range 51789-51798" in docs and mental models; an explicit `INTERVU_PORT` restores the old single-port behaviour.
- A Session idle past the TTL silently leaves the Home view; re-opening the handle resurrects it, and the TTL is tunable.
- `state.json` grows `lastActivityAt`; files written by older versions load with the field defaulted to the load time, so nothing expires on the first read after upgrade.
- A redacted snapshot withholds text the agent might have wanted; that is the point, and the human's message still carries intent.
- A new plugin against an old daemon loses reporting and range discovery but keeps today's relay behaviour; an old plugin against a new daemon keeps working untouched.
- The 403 body grows fields; anything parsing it as a bare code must read the reason field instead.

## Done means

- **Automated** (run through the `verify` skill: Biome, types, vitest and the Playwright suite against the real daemon plus the fixture apps):
  - verify: behind the https proxy fixture with a mismatched trust setup, the badge reads "refused by dev server", names the reason, and the card echoes the page origin.
  - verify: with the daemon stopped, the badge card says no daemon answered; with the daemon up and no Session, it shows the open command.
  - verify: after a refusal, `intervu status` lists the plugin's origin, the refusal tally with its reason, and the waiting origin.
  - verify: `intervu http://<host>:443` prints the scheme warning; opening a non-waiting origin while the fixture tab polls prints the did-you-mean line naming the waiting origin.
  - verify: `intervu doctor <proxied-url>` fails the guard check with the same reason the dev server logged, and passes end-to-end once the proxy forwards the right headers.
  - verify: with `redact: true`, a sent Feedback's snapshot and annotation text contain no fixture text or digits, selectors still resolve against the snapshot, `data-intervu-src` survives, and the poll output marks the redaction; the `data-intervu-redact` region is masked even with `redact` off.
  - verify: a Session whose persisted `lastActivityAt` is older than the TTL is absent from bare `intervu`, swept to `ended` by the daemon, and resurrected by re-open.
  - verify: a second daemon with a different state dir binds 51790, `/health` on both names distinct state dirs, and the relay finds a Session opened on either daemon.
  - verify: with an unwritable state dir, commands run against the `$TMPDIR` fallback and `status` names it.
  - verify: through the dropping proxy fixture, a single `intervu poll <url>` with no `--timeout` outlives three forced connection cuts and returns the Feedback sent after them.
  - verify: `intervu setup vite` in a temp project writes `.intervu/vite.mjs`, prints the import line, is a no-op on the second run, and the written file loads in a Vite config.
  - verify: the existing artifact-mode and URL-mode e2e specs pass unchanged.
- **Manual**:
  - Daniel re-runs the real-app-behind-nginx setup from scratch using only the README's reverse-proxy section, and `doctor` plus `status` answer every question that needed a human relaying the tab today.
  - A pixel check of the refused badge and its card on that app.
