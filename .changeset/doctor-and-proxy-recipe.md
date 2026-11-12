---
"intervu": minor
---

`intervu doctor <url>` replays the overlay's exact Session lookup - same path, same `?origin=`, same Origin header, so the false pass a bare `curl` gives cannot happen - and prints a per-check verdict: app reachable, plugin answering, guard verdict with the rejection reason on a refusal, daemon reachable from the plugin, and whether an open Session matches the origin. Every failing check carries a fix hint and the run exits non-zero. The README gains a "Behind a reverse proxy" section with working nginx and Caddy blocks (forward Host with its port, set X-Forwarded-Proto, buffering off, body limit up), and the Skill's troubleshooting now points at `intervu doctor` and `intervu status` as the first moves.
