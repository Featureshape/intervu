## Decision record: live app review (intervu URL mode)

**Pain**: The person running the agent session wants their real localhost app open in the browser, and wants the agent to change the code and have the running product update in front of them.
Today intervu only reviews a single HTML file on disk, served inside a sandboxed iframe, so a real app cannot be reviewed at all.

**Wedge**: A local Vite + React app.
The human annotates the running app, the agent edits the source, and the dev server's hot reload shows the change.
Nothing else.

**Premise**: An agent that receives what the human clicked (selector, DOM snapshot, page URL, and the source location) can find and edit the right code in a real app reliably enough that pointing beats describing.
It survives as long as the agent edits the right file on the first try for at least 8 of 10 annotations in a manual run on a real app.

### Settled
- **Delivery**: An in-page Vite plugin puts the overlay and conversation panel directly into the real `localhost` tab, inside a shadow root.
  Rejected: proxy + iframe, because the human wants their real localhost tab, not a framed copy.
  Rejected: browser extension, because it means building and maintaining an extension.
- **Source locations in v1**: Each annotation carries `file:line:col` of the JSX that rendered the clicked element.
  Rejected: shipping selector + snapshot + URL only, because that tests the premise less directly.
- **Source-location mechanism**: In dev only, the plugin's JSX transform stamps `data-intervu-src="<path>:<line>:<col>"` on intrinsic elements (lowercase tags, never components), and an annotation reads the nearest such attribute up the tree.
  Rejected: reading React internals, because React 19 removed `_debugSource` and the internals are undocumented and version-bound.
- **Session identity**: A URL-mode Session is keyed by origin (`localhost:5173`), and each annotation records its own `pageUrl`.
  Rejected: keying per full URL, because navigating between routes would split one review into many conversations.
- **Dev server not running**: `intervu <url>` fails fast with a structured `AppUnreachable` error (ADR 0014 contract) and does nothing else.
  Rejected: opening a waiting state, because it hides the real problem from the agent.
- **No open Session**: The plugin shows a small dormant badge ("intervu: no agent") whose click shows the command to hand the agent.
  Rejected: a hidden overlay, because it gives no sign intervu is wired.
  Rejected: auto-creating a Session from the page, because a Session would appear for every dev server the human opens.
- **Opening the tab**: `intervu <url>` registers the Session and opens no browser tab by default; the overlay appears in the already-open app via the SSE stream, and `--open` opens a tab on request.
  Rejected: opening a tab every time, because it piles up duplicate tabs of an app already open.
- **Page-to-daemon traffic**: The plugin mounts a `/__intervu/*` middleware on the Vite dev server that relays HTTP and SSE to the daemon, and rejects requests whose `Origin` does not match the dev server.
  The daemon stays loopback-only and sends no CORS headers.
  Rejected: a CORS allowlist on the daemon, because the dormant badge cannot ask without CORS, and a stopped daemon would print connection-refused errors in the app's console that cannot be suppressed.
- **Overlay placement**: A floating, movable, collapsible panel over the app.
  Rejected: docking to the right edge, because shrinking the viewport shifts the app's responsive breakpoints away from what is being reviewed.
- **Installing the plugin**: The agent adds `intervu()` to `vite.config.ts`, guided by the Skill; `intervu setup` keeps wiring only `~/.claude` and never edits project files.
  When the plugin is missing (`/__intervu/health` does not answer), `intervu <url>` still opens the Session and its output carries a help line saying so.
  Rejected: `setup` editing build config, because automatic edits to user build config are risky and vary too much per project.
- **Command shape** (decided for you): `intervu http://localhost:5173` reuses the existing verb, and a URL argument selects URL mode; cheap because it is a parser branch.
- **Who runs the dev server** (decided for you): the human; intervu only attaches to a running URL, cheap to extend later.
- **Which code the agent edits** (decided for you): the repo in the agent's working directory; intervu needs no source-root knowledge.
- **Reload** (decided for you): the dev server's HMR does it, and URL mode runs no file watcher; cheap because the watcher stays in artifact mode.
- **Artifact mode** (decided for you): unchanged; URL mode is a second target kind beside it.
- **Packaging** (decided for you): a `intervu/vite` subpath export, built as dependency-free ESM into `dist`, because Vite runs on Node and the main binary needs Bun (ADR 0018); `apply: 'serve'` keeps it out of production builds.
- **No Bridge in URL mode** (decided for you): SDK and chrome share one document, so the postMessage layer is not used.
- **Port** (decided for you): the plugin reads the same default port and `INTERVU_PORT` as the CLI.
- **Feedback fields** (decided for you): annotations gain `source` and `pageUrl`, and the Skill documents URL mode and plugin installation.
- **Drafts across full reload** (decided for you): unsent annotations persist in `sessionStorage`, available now that the overlay is same-origin with the app.
- **Snapshot and selector scope** (decided for you): the overlay's shadow root is excluded from DOM snapshots, and selectors ignore `data-intervu-src`.
- **Stacking** (decided for you): the panel renders in the browser top layer (popover API) so app `z-index` cannot cover it; its position persists in `sessionStorage`.
- **Transform scope** (decided for you): the JSX transform skips `node_modules`, so clicks in third-party components resolve to the nearest user-code element.
- **Vite support** (decided for you): the current Vite major and the one before it.
- **Multiple tabs** (decided for you): every tab on the origin shows the same Session, kept in sync by the SSE stream.

### Terms
- **URL mode**: an intervu Session whose target is a running dev-server origin instead of an HTML artifact on disk.
- **In-page overlay**: intervu's chrome and SDK running inside the app's own document, in a shadow root, instead of around an iframe.
- **Dormant badge**: the in-page overlay's resting state when no Session is open for the origin.
- **Relay**: the plugin's `/__intervu/*` dev-server middleware that forwards same-origin page traffic, SSE included, to the loopback daemon.
- **Source location**: the `file:line:col` of the JSX that rendered an annotated element, read from `data-intervu-src`.

### Found during recon
- Artifact content is read from `session.path` and served under `/s/:key/a/*` with the SDK injected (`src/Server.ts:136`).
- The artifact iframe is sandboxed without `allow-same-origin` (`src/ArtifactAssets.ts:223`, ADR 0003), which breaks cookies, storage and same-origin fetches for a real app.
- Live reload stats the single artifact file and pushes `ArtifactReloaded` (`src/ArtifactWatcher.ts`).
- The Session key is `hash(realpath)` of the artifact (ADR 0001).
- The daemon binds `127.0.0.1` (`src/AppConfig.ts:87`) on a fixed default port overridable by `INTERVU_PORT`.
- The published package is a Bun-only single-file binary with `files: ["dist"]` (ADR 0018), so a Node-run Vite plugin needs its own dependency-free build output.
- ADR 0003 already lists "`allow-same-origin` on a distinct origin" as a deferred option.

### Not doing
- Next.js, webpack, or any non-Vite dev server.
- Source locations for non-JSX frameworks (Vue, Svelte).
- Remote or client screens; the daemon stays loopback-only.
- Proxy + iframe delivery, or a browser extension.
- `intervu setup` editing `vite.config`.
- Anything in production builds.
- intervu starting the dev server.

### Accepted breakage
- `data-intervu-src` appears in the dev DOM and in dev-mode snapshot tests; production builds are untouched.
- Two projects run on the same port at different times share a Session; `end` and re-open cover it.
- A full Vite reload resets the panel's open or collapsed state; unsent drafts survive.

### Done means
- Automated (Playwright against a fixture Vite + React app in `e2e/`):
  - With the daemon down, the dormant badge shows and the console has no errors.
  - `intervu <url>` makes the overlay appear within 2 seconds.
  - An annotation reaches `poll` carrying `source` (`file:line:col`) and `pageUrl`.
  - The agent edits a source file, HMR updates the view, and the Conversation and drafts survive.
  - A relay request with a foreign `Origin` is rejected.
  - A page without the plugin yields the missing-plugin help line.
  - A dev server that isn't running yields `AppUnreachable`.
  - `vite build` output contains no intervu code and no `data-intervu-src`.
- Manual:
  - Daniel runs it on one of his real Vite apps and the agent edits the right file first try for at least 8 of 10 annotations.
  - A pixel check of the floating panel and dormant badge on that app.

### Reversibility
Everything is additive and artifact mode is untouched, so undoing means deleting the plugin and the URL-mode branch.
The one costly surface is the published `intervu/vite` export, since removing it breaks users' Vite configs.
Rethink if the agent falls below 8 of 10 first-try hits despite source locations (the premise fails), or if real use demands Next.js (reopens proxy + iframe or a Next plugin).
