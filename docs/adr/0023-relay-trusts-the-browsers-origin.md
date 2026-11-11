# The relay keys a page by the browser's own origin

## Status

accepted; extends ADR 0022

## Context

ADR 0022 keys a URL-mode Session by the app's origin, as `intervu <url>` reads it from the URL the agent types.
The `intervu/vite` relay first rebuilt that origin from its own side of the connection: `https` when Vite serves TLS, else `http`, then `://` and the `Host` header.
It used the result twice: the `Origin` header had to equal it exactly, and it was the origin the relay asked the daemon about.

Behind a reverse proxy that terminates TLS, as a company hostname in front of a local dev server usually is, that rebuild is wrong.
The browser is on `https://app.example.com`, but Vite serves plain http and sees `Host: app.example.com:443`, so the relay rebuilt `http://app.example.com:443`.
The overlay script was refused with a `403` because its `Origin` did not match, and the Session lookup asked about an origin no Session was opened for.
Neither failure said anything anywhere.

## Decision

The page's origin is what the browser says it is, checked against what the dev server can vouch for.

- The overlay names its own `location.origin` in an `origin` query parameter on every relay request.
  An `EventSource` cannot set headers, so a query parameter is the one carrier every request has.
- The relay accepts an `Origin` header, and the named page origin, when it is an `http:` or `https:` origin whose hostname the dev server trusts (loopback names, IP literals, Vite's `server.allowedHosts`), and whose host and port are the `Host` the request arrived with or the host a proxy forwarded (`X-Forwarded-Host`, or `host=` in `Forwarded`).
  The scheme is not compared, and a `Host` without a port takes the default port of the origin's scheme, so `https://app.example.com` matches both `Host: app.example.com:443` and `Host: app.example.com`.
- When both are present they must agree.
- A request naming neither, such as the CLI's, gets the origin from the forwarded scheme and host, else the server's own scheme and `Host`.
- The `Host` check and the `Sec-Fetch-Site` check stay as they were: those are what keep DNS rebinding and other sites out.
- Every refusal logs one line through Vite's logger with the reason and the headers the relay saw, once per distinct message.

`intervu <url>` asks the relay the same question the overlay asks, at the origin the agent typed, and compares the answer with the Session it just opened.
Its help line then says whether the plugin sees the Session, refused the request, reaches a different daemon, or is missing.
Its probes accept any TLS certificate, because a dev server on https usually has one from a local CA that Bun does not trust, and the probes send nothing secret.

## Considered options

- **Trust the browser's origin, checked against `Host` and forwarded headers** - chosen: a proxy works with no configuration beyond what Vite already needs (`server.allowedHosts`), and a mismatch explains itself.
- **Honour `X-Forwarded-Proto` only** - rejected: it fixes the scheme but not the port, needs a proxy that sends it, and a proxy that forgets it still fails silently.
- **A plugin option naming the public origin** - rejected: one more thing to configure, and it goes stale when the hostname changes.

## Consequences

- An app behind nginx, Caddy or a corporate gateway works when the gateway passes the browser's `Host` (or `X-Forwarded-Host`) and the hostname is in `server.allowedHosts`, which Vite already requires for that hostname.
- Ignoring the scheme lets a page on `https://localhost:5173` reach a relay on `http://localhost:5173`; a browser marks a request across schemes as cross-site, so `Sec-Fetch-Site` still turns it away.
- A script in the app's page can name any origin the dev server answers to, but only one whose host and port are this dev server's, so it cannot reach another app's Session.
