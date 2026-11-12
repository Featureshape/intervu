# intervu

intervu is a local, AXI-style CLI that turns an agent-generated HTML artifact
into a collaborative browser review surface: the human annotates the rendered
page, and the agent long-polls for that feedback and live-edits the file.

See [`CONTEXT.md`](CONTEXT.md) for the ubiquitous language and
[`docs/adr/`](docs/adr/) for the architectural decisions.

## Install

The review loop runs by having your agent shell out to a bare `intervu` command, so `intervu` has to be on your `PATH`.
intervu ships as a single self-contained [Bun](https://bun.sh) binary, so you need Bun on your `PATH` too.
Install it globally and wire it into your agent:

```bash
bun add -g intervu
intervu setup
```

`intervu setup` installs the agent skill and the session-start hook that make the review loop discoverable.
It refuses when `intervu` is not yet on your `PATH`, because the skill and hook it writes both invoke a bare `intervu` - a transient `bunx` run would leave them pointing at a command that does not exist.

For a one-off manual look at an artifact you can run it without installing, but this is not enough for the agent loop:

```bash
bunx intervu report.html
```

## Local development

Install dependencies:

```bash
bun install
```

Run the dev server (watches and restarts on file changes):

```bash
bun run dev
```

## Usage

Open an artifact for review - launches the browser chrome around it:

```bash
intervu open report.html
# bare-file alias:
intervu report.html
```

Long-poll for human feedback; blocks until the human acts, then returns the
queued feedback as TOON. Safe to kill and re-run with no loss:

```bash
intervu poll report.html
# post a reply into the human's conversation panel as you re-poll:
intervu poll report.html --agent-reply "tightened both headings"
```

Post into the conversation panel without waiting, for example to acknowledge
feedback or answer a question while a poll stays open:

```bash
intervu reply report.html "looking at the billing code now"
```

Review a running Vite app instead of a file (URL mode): add the `intervu/vite` plugin to the app's dev server, then open a Session on the URL the browser uses.
The same `poll`, `reply` and `end` commands take the origin as the handle:

```bash
intervu http://localhost:5173
intervu poll http://localhost:5173
```

When something in the loop looks wrong, two commands answer before any guessing does:

```bash
intervu status                      # what the daemon and the plugin report
intervu doctor http://localhost:5173  # replay the overlay's exact lookup, per-check verdict
```

## Behind a reverse proxy

A TLS-terminating proxy (nginx, Caddy) in front of the dev server is the setup where the review loop most often goes silent: the browser is on `https://app.example.com` while Vite sees plain http, and the plugin's relay refuses requests it cannot prove came from the dev server's own page.
Four things must hold:

- the proxy forwards the browser's `Host` **with its port** (or sets `X-Forwarded-Host`), so the relay can match the page's origin;
- the proxy sets `X-Forwarded-Proto`, so the dev server knows the browser is on https;
- response buffering is off, so the panel's live SSE stream is not held back;
- the request body limit allows a page snapshot (a few MB on a heavy page).

And in `vite.config.ts`, the public hostname must be in `server.allowedHosts`:

```ts
export default defineConfig({
  plugins: [react(), intervu()],
  server: { allowedHosts: ["app.example.com"] },
});
```

nginx:

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  "" close;
}

server {
  listen 443 ssl;
  server_name app.example.com;

  location / {
    proxy_pass http://127.0.0.1:5173;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;              # the browser's Host, port included
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;        # Vite's HMR websocket
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;                           # the panel's SSE stream
    client_max_body_size 32m;                      # Feedback page snapshots
  }
}
```

Caddy (which forwards `Host` and sets `X-Forwarded-Proto` on its own):

```caddy
app.example.com {
  reverse_proxy 127.0.0.1:5173 {
    flush_interval -1   # the panel's SSE stream
  }
  request_body {
    max_size 32MB
  }
}
```

Then prove the path end to end - the doctor replays the overlay's exact lookup, so a pass means the badge in the browser will find its Session:

```bash
intervu doctor https://app.example.com
```

## Feedback loop

```bash
bun run format       # biome format --write
bun run lint         # biome lint --write
bun run check        # biome check --write (combined + import sort)
bun run check:types  # tsc --noEmit (effect-tsgo-patched)
bun run test         # vitest run
```

## Releasing

Releases are automated with [Changesets](https://github.com/changesets/changesets).
To record a change for the next release:

```bash
bun run changeset    # describe the change and pick a semver bump
```
