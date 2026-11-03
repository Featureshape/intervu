# The poll delivers the DOM snapshot as a file path, not inline

## Status

accepted; amends ADR 0008

## Context and decision

ADR 0008 had the snapshot ride inline in the poll's TOON to the agent.
Every Feedback therefore put a whole page into the agent's context, even a plain question with no annotations, and those copies stayed there for the rest of the review.
A 60 KB page is roughly 15-20k tokens per Feedback, which slows long reviews and can force compaction.
Most Feedback does not need it, because each annotation already carries its selector, tag, and surrounding text, and the agent can edit the source from those.

The snapshot is still the live DOM captured over the Bridge, and it still rides inline on the wire from the daemon to the CLI.
On delivery, `intervu poll` writes it to `<stateDir>/snapshots/<artifact-hash>/<content-hash>.html` and prints `domSnapshotPath` in place of `domSnapshot`, so the agent reads or searches the file only when it needs to.
The CLI does the writing because it is the last step before the agent; the `/poll` response and the daemon's in-memory queue (ADR 0002) are unchanged.

## Considered options

- **File written by the CLI, inline fallback** - chosen: the smallest change, with no daemon or wire changes.
- **Daemon writes the file and sends a path** - rejected: it changes the wire and the queue for no gain to the agent.
- **Drop the snapshot unless the agent asks for it** - rejected: it needs a new daemon route, and the snapshot must be captured at Send anyway, because the live DOM may be gone by the time the agent asks.
- **Send only the annotated element's HTML** - rejected for now: a useful later addition, but an unannotated question has no element to send, and selectors still need the whole document to resolve.

## Consequences

- The daemon has already drained the Feedback when the CLI holds it, so a failed write must not fail the poll. The CLI falls back to the inline `domSnapshot` and reports the problem on stderr, keeping the promise that Feedback is never lost.
- Snapshots now reach disk, which ADR 0002 kept them off for size and transience, not secrecy. Because a page can hold private data, the directories and files are owner-only.
- Disk use is bounded: each artifact keeps its newest 20 snapshots, and identical snapshots share one file, which is the dedupe ADR 0008 deferred. There is no age-based expiry, so the files for a finished review stay until the state directory is cleared.
- An older snapshot can be pruned while an agent still intends to read it, only after 20 newer distinct ones.
