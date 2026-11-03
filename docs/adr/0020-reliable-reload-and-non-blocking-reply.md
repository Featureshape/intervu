# Live-reload survives dropped connections and large repos; replies do not need a poll

## Status

accepted; amends ADR 0010

## Context and decision

Live-reload missed edits in real reviews, most visibly the agent's last edit of a turn, which no later save would recover.
Three things combined to cause it.
Bun closes a connection after 10s without bytes by default, so the SSE stream dropped every 9-13s, between its 20s pings; ADR 0010 called the ping loopback insurance, but it was never frequent enough to hold the connection.
A reload nudge was momentary and never replayed, so an edit landing in a reconnect gap was lost.
`FileSystem.watch` is always recursive, so an artifact inside a large repo walked and watched the whole subtree, and a same-named file anywhere below it looked like an edit.

The daemon now sets `idleTimeout: 0`, which is safe because it is loopback-only and a dead client still delivers FIN/RST.
`ArtifactReloaded` carries the artifact's version (modified time plus size), and the SSE route sends that version on every connect as well as on every edit.
The chrome starts from the version embedded in its page and reloads only when a frame differs from the version it shows, so missed edits are recovered and repeats are harmless.
The watcher stats the one artifact path every 100ms and publishes on a debounced version change, instead of watching a directory.

A reload also jumped the human back to the top of the page, which stops being tolerable once an agent fills a skeleton in over several saves.
The SDK reports the artifact's window scroll position up the Bridge (`scroll-changed`), and the chrome sends the latest one back after each reload (`restore-scroll`).

Separately, an Agent-reply could only be posted by `poll --agent-reply`, which then blocks, so an agent could not acknowledge feedback or answer a question while a poll stayed open.
`intervu reply <file> <message>` (`POST /reply`) posts one and returns at once, which lets the agent explore other parts of a codebase during a review while a background poll keeps listening.

## Considered options

- **Stat one path on a tick** - chosen: constant cost at any repo size, no inotify watches to exhaust, immune to activity elsewhere in the tree, and correct across an atomic-save rename-replace.
- **Non-recursive `fs.watch` on the parent directory** - rejected: lower idle cost, but it bypasses the `FileSystem` service, needs its own error handling, and brings back a watcher that can fail where a stat cannot.
- **Keep the nudge and only shorten the ping** - rejected: it narrows the gap but any other drop, such as a laptop sleeping, would still lose an edit; the version on connect covers them all.

## Consequences

- A single edit reaches the browser within about 250ms (tick plus debounce), slightly slower than the old watcher's ~100ms, in exchange for reliability.
- Each artifact with an open tab costs 10 stats per second, only while its SSE stream is open.
- An edit that keeps both modified time and size unchanged is not detected; in practice that needs a deliberately restored mtime.
- Only the window's scroll position is restored; a scroll container inside the artifact, and scroll-dependent script state, still reset on reload.
- `poll --agent-reply` stays for the common reply-then-listen step; `reply` covers everything that must not block.
