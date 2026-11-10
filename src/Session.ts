import { Effect, Schema } from "effect";

/**
 * Stable identifier for a Session: the SHA-256 hex of its handle, truncated to
 * 16 chars - the artifact's resolved realpath (ADR 0001), or the dev server's
 * origin for an `app` Session (ADR 0022). Never content-derived, so it survives
 * the agent's live edits.
 */
export const SessionKey = Schema.String.pipe(Schema.brand("SessionKey"));
export type SessionKey = typeof SessionKey.Type;

/**
 * A Session's lifecycle status. `open` on a created or resumed Session; `ended`
 * once the human or the agent ends it (`SessionStore.end`). The transition is
 * reversible (ADR 0012): re-opening an `ended` path resurrects it to `open`.
 */
export const SessionStatus = Schema.Literals(["open", "ended"]);
export type SessionStatus = typeof SessionStatus.Type;

/**
 * What a Session reviews (ADR 0022): an `artifact` HTML file on disk, or the
 * running `app` behind a dev-server origin (URL mode). A missing value decodes
 * as `artifact`, so state files and requests from before URL mode still load.
 */
export const SessionKind = Schema.Literals(["artifact", "app"]).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed("artifact")),
);
export type SessionKind = typeof SessionKind.Type;

/**
 * The review context for one artifact or app, keyed by its handle-derived
 * `key`. `path` is that handle - the artifact's realpath, or the app's origin -
 * and every command addresses the Session by it. The daemon's `SessionStore`
 * solely owns these (ADR 0002); they cross the HTTP boundary and persist to the
 * state file via the same schema.
 */
export class Session extends Schema.Class<Session>("Session")({
  key: SessionKey,
  path: Schema.String,
  status: SessionStatus,
  kind: SessionKind,
}) {}
