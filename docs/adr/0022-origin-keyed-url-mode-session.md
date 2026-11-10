# A URL-mode Session is keyed by the app's origin

## Status

accepted; extends ADR 0001

## Context and decision

URL mode reviews a running dev server instead of an HTML file on disk, so a Session needs a target that is not a path.
`intervu <url>` reads an absolute `http:` or `https:` argument as an app URL and anything else as the artifact file it always was.
The Session's handle is the URL's origin, such as `http://localhost:5173`, and its key is the SHA-256 of that handle cut to 16 hex characters, the same derivation ADR 0001 uses for a realpath.
Every route of one dev server therefore opens or resumes the same Session, and each annotation records the page it was made on.

A Session now carries a `kind`, `artifact` or `app`.
Its `path` field stays the handle every command takes: the realpath for an artifact, the origin for an app.
A Session or `POST /sessions` body without a `kind` decodes as an `artifact`, so state files and clients from before URL mode keep working.
The daemon's routes that serve an artifact's file (`/s/:key`, `/s/:key/a/*`, `/s/:key/source`) answer `404` for an `app` Session, which has no file behind its handle.

`intervu <url>` opens no browser tab, because the human already has the app open; `--open` opens one at the URL as given.
`INTERVU_BROWSER` names the program that opens a tab in both modes, run with the URL as its only argument, so a test or an unusual setup can stand in for the OS default browser.

## Considered options

- **Origin as the handle, with a `kind` beside it** - chosen: one key derivation and one lookup for both modes, and the persisted shape only grows a field.
- **One Session per full URL** - rejected: moving between routes would split one review into many Conversations.
- **A separate target union in place of `path`** - rejected: it renames the field the Home view, the state file and every path-addressed route already share, for no change in behaviour.

## Consequences

- An absolute realpath starts with `/` and an origin with its scheme, so an artifact and an app never share a key.
- Two projects served on the same port at different times share a Session; `end` and a re-open cover it.
- `localhost` and `127.0.0.1` on the same port are two origins, and so two Sessions, as they are to the browser.
