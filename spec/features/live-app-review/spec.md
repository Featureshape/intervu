# Spec: live app review (intervu URL mode)

## Problem

The person running an agent session wants to review their real app, running on `localhost`, in the tab they already have open.
They want to point at what is wrong, have the agent change the code, and see the running product update in front of them.
Today intervu can only review a single HTML file on disk, served inside a sandboxed iframe with an opaque origin.
A real app cannot be reviewed at all: cookies, storage and same-origin fetches break inside that sandbox, and there is no command that accepts a URL.
Every time Daniel works on one of his Vite apps with an agent, he falls back to describing elements in prose instead of pointing at them.

## Solution

A Vite plugin, imported from `intervu/vite`, puts intervu's overlay and conversation panel directly into the running Vite + React app, inside a shadow root.
`intervu http://localhost:5173` opens a Session for that origin, and the overlay appears in the tab that is already open.
The human annotates the live app; each annotation reaches the agent with the `file:line:col` of the JSX that rendered the clicked element and the page URL it was made on.
The agent edits the source, and Vite's hot reload shows the change without losing the Conversation or unsent drafts.
Artifact mode keeps working exactly as it does today.

## Current state

- **CLI entry.**
  A bare first argument that is not a known subcommand is rewritten to `open <arg>` (`src/main.ts:373-390`).
  `open` takes `Argument.file("file")`, resolves its realpath or fails with `ArtifactNotFound`, runs `lifecycle.ensure`, opens the Session and always opens a browser tab (`src/main.ts:71-95`).
  `poll`, `reply` and `end` also take `Argument.file` and resolve a realpath (`src/main.ts:107-214`), so none of them accepts a URL today.
  The Home view rows carry `{key, path, status}` and its help line names `<file>` (`src/main.ts:42-64`).
- **Session model.**
  A Session is `{key, path, status}` (`src/Session.ts:24-28`).
  Its key is SHA-256 of the artifact's realpath, cut to 16 hex characters (`src/SessionStore.ts:82-93`, ADR 0001).
  `SessionStore.open` is idempotent and resurrects an `ended` Session (`src/SessionStore.ts:95-120`, ADR 0012).
  Only status persists across daemon restarts; feedback queues and Conversations are in memory (`src/SessionStore.ts:73-79`).
- **Annotation and Feedback.**
  `ElementAnnotation` is `{kind, selector, tag, text}` and `TextAnnotation` adds `selectedText` (`src/Protocol.ts:34-51`).
  `Feedback` is `{message, annotations, domSnapshot}` (`src/Protocol.ts:61-78`).
  The agent sees `PollAnnotationView {n, kind, selector, tag, text, selectedText?}` and a `domSnapshotPath` (`src/Output.ts:79-132`).
  There is no `source` or `pageUrl` field anywhere.
- **Daemon HTTP.**
  Routes live in `src/Server.ts:77-611`: `/health` (`:77`), `POST /sessions` (`:86`), the chrome page `/s/:key` (`:108`), the artifact `/s/:key/a/*` (`:136`), `POST /s/:key/feedback` (`:221`), `POST /poll` (`:289`), `POST /reply` (`:339`), the two end routes (`:423`, `:446`) and the SSE stream `/s/:key/events` (`:488`).
  Every Session-scoped route is addressed by key; an unknown key returns an empty 404 (`src/Server.ts:50-75`).
  There is no route that finds a Session by anything but its key or artifact path.
  The daemon binds `127.0.0.1` (`src/AppConfig.ts:87`) on port 51789 or `INTERVU_PORT` (`src/AppConfig.ts:15`, `:55-56`).
  No CORS headers or `Origin` checks exist anywhere in `src/`.
- **SSE stream.**
  On connect it starts the artifact watcher, replays the Conversation after `Last-Event-ID`, then sends Presence, `ArtifactReloaded(version)` and `SessionEnded` if ended (`src/Server.ts:504-528`).
  It streams live hub events with a 20s `: ping` (`src/Server.ts:529-535`); frames are built in `src/Sse.ts:21-85`.
  Each SSE connection is a live connection, so an open tab keeps the daemon from idle shutdown (`src/IdleShutdown.ts:27-37`, ADR 0016).
- **Live reload.**
  `ArtifactWatcher` stats the single artifact file every 100ms and publishes `ArtifactReloaded` (`src/ArtifactWatcher.ts:71-137`); the chrome reloads the iframe on a new version (`src/chrome/entry.ts:597-626`).
- **Browser code.**
  The chrome (`src/chrome/entry.ts`) is a full page around the artifact iframe; it owns the composer, the pending-annotation list (`:163`, `:213-224`), Presence (`:480`), Conversation bubbles (`:529`), the ended state (`:635-656`) and the `EventSource` (`:688-697`).
  The SDK (`src/sdk/entry.ts`) runs inside the iframe, captures clicks in annotate-mode (`:70-90`) and answers snapshot requests with `document.documentElement.outerHTML` (`:146-153`).
  The marker overlay already lives in a shadow root (`src/sdk/overlay.ts:79-89`, ADR 0005).
  Selectors come from `@medv/finder` (`src/sdk/selector.ts:11`).
  The two halves talk only over the postMessage Bridge (`src/sdk/bridge.ts:91-141`, ADR 0003).
  Pending annotations are not stored anywhere: there is no `localStorage` or `sessionStorage` in `src/`.
  The iframe sandbox is `allow-scripts allow-forms allow-popups` without `allow-same-origin` (`src/ArtifactAssets.ts:223`).
- **Build and packaging.**
  Browser bundles are built with `Bun.build` as IIFE (`src/BrowserAssets.ts:23-43`) and baked into `src/generated/browserAssets.ts` by `scripts/build-browser.ts` (ADR 0007).
  The shipped artifact is one Bun binary, `dist/intervu` (`scripts/build.ts:12-34`, ADR 0018).
  `package.json` has `bin` and `files: ["dist"]` but no `exports` field, and no `vite`, `react` or `@vitejs/plugin-react` dependency.
  Nothing in the repo runs on plain Node.
- **Errors.**
  Domain errors are tagged classes in `src/Errors.ts:10-135`, rendered as `{error:{tag,message}, help}` TOON on stdout by `src/ErrorReport.ts:19-178` (ADR 0014).
- **Discovery.**
  The Skill (`src/skill/SKILL.md`) describes only the artifact loop.
  `intervu setup` writes only under `~/.claude` or the project `.claude` (`src/Setup.ts:90-155`).

## Behaviour

1. In a Vite + React app with `intervu()` in `vite.config.ts` and no daemon running, the page shows a small "intervu: no agent" badge and the browser console has no intervu errors.
2. Clicking the dormant badge shows the command to hand the agent, such as `intervu http://localhost:5173`.
3. `intervu http://localhost:5173` opens a Session for that origin and prints it as TOON with a help line naming the next `poll`.
4. Within 2 seconds of that command, the overlay replaces the dormant badge in every already-open tab of that origin, with no page reload.
5. `intervu <url>` opens no browser tab; `intervu <url> --open` opens one.
6. When nothing answers at the URL, `intervu <url>` exits 1 with a structured `AppUnreachable` error and opens no Session.
7. When the page answers but `/__intervu/health` does not, `intervu <url>` still opens the Session and its output carries a help line saying the Vite plugin is missing and how to add it.
8. Running `intervu <url>` again on the same origin, on any route, resumes the same Session.
9. `intervu poll <url>`, `intervu reply <url> "<msg>"` and `intervu end <url>` act on the origin's Session the way they do on a file's.
10. Bare `intervu` lists an open URL-mode Session beside artifact Sessions.
11. The overlay is a floating panel over the app that the human can move and collapse; the app's viewport width does not change.
12. The panel stays above the app's own content regardless of the app's `z-index` values.
13. In annotate-mode, clicking an element in the app creates an annotation instead of triggering the app's handler; with annotate-mode off, the app behaves natively.
14. A Feedback reaching `poll` carries, per annotation, `source` as `file:line:col` of the JSX element that rendered it, and the `pageUrl` the annotation was made on.
15. Clicking inside a third-party component reports the `source` of the nearest enclosing element written in the app's own code.
16. Annotation selectors never mention `data-intervu-src`, and the DOM snapshot contains no intervu overlay markup.
17. Annotations made on two different routes of the app land in the same Session, each with its own `pageUrl`.
18. When the agent edits a source file, Vite's hot reload updates the view and the panel keeps its Conversation, pending annotations and position.
19. After a full page reload, unsent drafts and the panel position come back; whether the panel was open or collapsed does not.
20. Every open tab on the origin shows the same Conversation, kept in sync live.
21. Agent-replies, Presence and the ended state appear in the in-page panel as they do in the artifact chrome.
22. A request to `/__intervu/*` whose `Origin` is not the dev server's own is rejected.
23. `vite build` output contains no intervu code and no `data-intervu-src` attribute.
24. The plugin works with the current Vite major and the one before it.
25. The Skill tells the agent how to open a URL-mode Session, how to add `intervu()` to `vite.config.ts`, and what `source` and `pageUrl` mean.
26. Artifact mode behaves exactly as before.

## Decisions

- **Delivery: an in-page Vite plugin.**
  The overlay and panel run inside the real `localhost` tab, in a shadow root.
  Lost: a proxy plus iframe, because the human wants their real tab, not a framed copy.
  Lost: a browser extension, because it means building and maintaining an extension.
- **Source locations ship in v1.**
  Each annotation carries the `file:line:col` of the JSX that rendered the clicked element.
  Lost: selector, snapshot and URL only, because that tests the premise (pointing beats describing) less directly.
- **Source locations come from a dev-only JSX transform.**
  The plugin stamps `data-intervu-src="<path>:<line>:<col>"` on intrinsic elements (lowercase tags, never components), skipping `node_modules`, and an annotation reads the nearest such attribute up the tree.
  Lost: reading React internals, because React 19 removed `_debugSource` and the internals are undocumented and version-bound.
- **A URL-mode Session is keyed by origin.**
  `localhost:5173` is one Session; each annotation records its own `pageUrl`.
  Lost: one Session per full URL, because moving between routes would split one review into many Conversations.
- **An unreachable dev server fails fast.**
  `intervu <url>` returns a structured `AppUnreachable` error under the ADR 0014 contract and does nothing else.
  Lost: opening a waiting state, because it hides the real problem from the agent.
- **No open Session shows a dormant badge.**
  Its click shows the command to hand the agent.
  Lost: a hidden overlay, because it gives no sign intervu is wired.
  Lost: auto-creating a Session from the page, because a Session would appear for every dev server the human opens.
- **No tab is opened by default.**
  The overlay appears in the already-open app through the SSE stream; `--open` opens a tab on request.
  Lost: opening a tab every time, because it piles up duplicate tabs of an app already open.
- **Page traffic goes through a same-origin relay.**
  The plugin mounts `/__intervu/*` on the Vite dev server, relays HTTP and SSE to the daemon, and rejects requests whose `Origin` is not the dev server.
  The daemon stays loopback-only and sends no CORS headers.
  Lost: a CORS allowlist on the daemon, because the dormant badge could not ask without CORS, and a stopped daemon would print connection-refused errors in the app's console that cannot be suppressed.
- **The panel floats.**
  It is movable and collapsible, rendered in the browser top layer (popover API), and its position persists in `sessionStorage`.
  Lost: docking to the right edge, because shrinking the viewport shifts the app's responsive breakpoints away from what is being reviewed.
- **The agent installs the plugin.**
  The Skill guides the agent to add `intervu()` to `vite.config.ts`; `intervu setup` keeps wiring only `.claude`.
  A missing plugin does not block `intervu <url>`; the output says so.
  Lost: `setup` editing build config, because automatic edits to user build config are risky and vary too much per project.
- **Command shape.**
  A URL argument to the existing verb selects URL mode.
  It reuses the existing verb, and the branch lives in the argument parser, so it is cheap.
- **The human runs the dev server.**
  intervu only attaches to a running URL.
  Lost: intervu starting the dev server, because it is cheap to add later and not needed for the wedge.
- **The agent edits the repo in its working directory.**
  intervu needs no knowledge of the source root.
- **Reload is Vite's HMR.**
  URL mode runs no file watcher and sends no `ArtifactReloaded`; the watcher stays in artifact mode.
- **Artifact mode is unchanged.**
  URL mode is a second target kind beside it.
- **Packaging: an `intervu/vite` subpath export.**
  It is built as dependency-free ESM into `dist`, because Vite runs on Node and the main binary needs Bun (ADR 0018), and it uses `apply: 'serve'` so it never enters production builds.
- **No Bridge in URL mode.**
  The SDK and the panel share one document, so the postMessage layer is not used.
- **The plugin finds the daemon the way the CLI does.**
  It reads the same default port and `INTERVU_PORT`.
- **Feedback grows two fields.**
  Annotations gain `source` and `pageUrl`.
- **Drafts persist in `sessionStorage`.**
  This is possible now that the overlay is same-origin with the app.
- **Snapshots and selectors ignore intervu.**
  The overlay's shadow root is excluded from DOM snapshots, and selectors ignore `data-intervu-src`.
- **Vite support covers two majors.**
  The current major and the one before it.
- **All tabs share one Session.**
  Every tab on the origin shows the same Session, kept in sync by the SSE stream.

## Seams

One seam: the Playwright E2E harness, extended.

- **Existing: the Playwright harness** (`playwright.config.ts:31-40`).
  It already boots the real daemon on `127.0.0.1:51990` with a throwaway `INTERVU_STATE_DIR`, and specs drive the daemon over HTTP with the `request` fixture (`e2e/support.ts:34-57`) and assert on `poll` results (`e2e/loop.spec.ts:18-72`) and live updates (`e2e/live.spec.ts:71-112`).
  URL mode is tested here, against a real Vite dev server, because every behaviour above is a browser, dev-server or CLI behaviour that only shows up end to end.
- **New within it: a fixture Vite + React app** under `e2e/fixtures/`, started by a second `webServer` entry with `INTERVU_PORT=51990` and the plugin loaded from source.
  No existing fixture will do: the only one is a static HTML artifact (`e2e/fixtures/artifact.html`), and the plugin, relay and JSX transform only exist inside a Vite dev server.
  The same app served from a second config without the plugin covers the missing-plugin path, and a port nothing listens on covers `AppUnreachable`.
- **New within it: a helper that runs the CLI** (`bun src/main.ts ...` with the harness's `INTERVU_PORT` and state dir) and decodes its stdout.
  No spec runs the CLI today, and nothing in `tests/` covers `src/main.ts`; `AppUnreachable`, the missing-plugin help line and the no-tab default are CLI output, so they cannot be asserted through the daemon's HTTP routes alone.
- **New within it: a spec that runs `vite build`** on the fixture app and searches the output for intervu code and `data-intervu-src`.

Pure logic that is cheaper to pin without a browser, such as the JSX transform's stamping rules, may also get vitest cases beside the existing `tests/` suite, but the Playwright specs are the proof.

## Sequence

1. With the plugin installed and no Session, the app shows the dormant badge, a clean console, and a production build without intervu in it.
2. `intervu <url>` opens an origin-keyed Session, the overlay appears in the open tab, and the unreachable and missing-plugin cases answer with their error and help line.
3. The human annotates the live app and sends; `poll <url>` returns Feedback with `source` and `pageUrl`, and `reply` and Presence show in the panel.
4. The agent edits the source; HMR updates the view with the Conversation intact, drafts survive a full reload, and the panel can be moved and collapsed.
5. The Skill documents URL mode and plugin installation, so a fresh agent can run the loop unaided.

## Out of scope

- Next.js, webpack, or any dev server other than Vite.
- Source locations for non-JSX frameworks such as Vue or Svelte.
- Reviewing remote or client screens; the daemon stays loopback-only.
- Proxy plus iframe delivery, or a browser extension.
- `intervu setup` editing `vite.config.ts`.
- Anything in production builds.
- intervu starting the dev server.
- Changes to artifact mode.

## Accepted breakage

- `data-intervu-src` appears in the dev DOM and in dev-mode snapshot tests; production builds are untouched, and the attribute is what makes source locations possible.
- Two projects run on the same port at different times share a Session, because the key is the origin; `end` and re-open cover it.
- A full Vite reload resets whether the panel was open or collapsed; unsent drafts and position survive, which is what matters for not losing work.
- `intervu/vite` becomes a published import path in users' Vite configs, so removing it later would break them.

## Done means

- **Automated** (run through the `verify` skill: Biome, types, vitest and the Playwright suite against the real daemon plus the fixture Vite app):
  - verify: with the daemon stopped, load the fixture app; the "intervu: no agent" badge shows, clicking it shows the `intervu <url>` command, and the console has no errors.
  - verify: run `intervu <fixture-url>`; within 2 seconds the overlay replaces the badge in the already-open tab, no new tab opened, and the stdout TOON names the Session and the next `poll`.
  - verify: run `intervu <fixture-url>` from a second route; the same Session key comes back.
  - verify: arm annotate-mode, click a fixture element, send; `poll <fixture-url>` returns that Feedback with `source` matching the element's JSX `file:line:col`, the current `pageUrl`, a selector without `data-intervu-src`, and a snapshot without overlay markup.
  - verify: click inside a fixture `node_modules` component; the annotation's `source` is the nearest app-code element.
  - verify: `reply <fixture-url> "<msg>"` shows the message in the panel of two open tabs.
  - verify: edit a fixture source file while an annotation is pending; HMR shows the change, and the Conversation, the pending annotation and the panel position are still there.
  - verify: reload the page with an unsent draft; the draft is still there.
  - verify: send a `/__intervu/*` request with a foreign `Origin`; it is rejected.
  - verify: run `intervu <url>` against the fixture app served without the plugin; the Session opens and the output carries the missing-plugin help line.
  - verify: run `intervu <url>` against a port nothing listens on; it exits 1 with an `AppUnreachable` TOON error and no Session is created.
  - verify: run `vite build` on the fixture app; the output contains no intervu code and no `data-intervu-src`.
  - verify: the existing artifact-mode E2E specs still pass unchanged.
- **Manual**:
  - Daniel runs it on one of his real Vite apps, and the agent edits the right file on the first try for at least 8 of 10 annotations.
  - A pixel check of the floating panel and the dormant badge on that app.
