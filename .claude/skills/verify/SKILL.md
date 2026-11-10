---
name: verify
description: Prove the intervu working tree is green the way CI and a reviewer would see it - Biome, types, unit tests and the Playwright E2E suite against the real daemon. Use before a commit, at a slice's done check, at a branch close, or whenever another skill asks whether the change passes.
---

# verify

Run every check below from the repo root, in order, and report each one's result.
A change is verified only when all of them pass.
These are read-only: none of them rewrites a file, so a failure means the change needs a fix, not a re-run.

## Checks

```bash
bunx --bun @biomejs/biome ci   # format, lint and import order, as CI runs them
bun run check:types            # tsc over src, the browser bundle and e2e/
bun run test                   # vitest unit and integration tests
bun run test:e2e               # Playwright against `bun src/main.ts server`
```

The first three match `.github/workflows` exactly.
`test:e2e` is not in CI, so it is the only place the chrome, the sandboxed artifact iframe and the postMessage Bridge are proven end to end; never skip it for a change that touches `src/` or `e2e/`.

## Before the first run

- `bun` must be on `PATH`; it usually lives at `~/.bun/bin`.
- Dependencies come from `bun install --frozen-lockfile`.
- Playwright needs its pinned Chromium: `bunx playwright install chromium`.
  A `browserType.launch: Executable doesn't exist` error means this step is missing, not that a test broke.
  Behind a TLS-intercepting proxy the download fails with `SELF_SIGNED_CERT_IN_CHAIN`; export the keychain roots with `security find-certificate -a -p /Library/Keychains/System.keychain /System/Library/Keychains/SystemRootCertificates.keychain > /tmp/ca.pem` and retry with `NODE_EXTRA_CA_CERTS=/tmp/ca.pem`.
- The E2E server binds `127.0.0.1:51990` and reuses one already listening there outside CI; stop a stale `bun src/main.ts server` on that port before trusting a result.

## On failure

- Fix the cause and re-run from the failing check, then run the whole list once more before calling it green.
- `bun run check` (with `--write`) can apply Biome's safe fixes; re-run `biome ci` afterwards.
- A failure in code the change did not touch is still a failure: fix it or report it, never skip it.
- An E2E test that passes on retry is flaky, not green; report it as flaky.

## Report

One line per check: the command, pass or fail, and the count where it prints one (for example `vitest 141 passed`, `playwright 19 passed`).
On a failure, quote the first failing test or diagnostic.
