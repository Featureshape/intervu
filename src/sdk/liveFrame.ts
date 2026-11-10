/**
 * Following the daemon's SSE stream (ADR 0010) in the browser, shared by the
 * artifact chrome and URL mode's in-page panel so both render the same
 * Conversation, Presence and ended state from the same stream. Every frame is
 * untrusted JSON, so it is checked field by field before anything reads it.
 * This module imports nothing, so either browser bundle can take it in.
 */

/** The agent's state in the review loop (CONTEXT.md "Presence"). */
export type Presence = "idle" | "listening" | "working";

/** One Conversation entry as the stream carries it. */
export interface ConversationEntry {
  readonly seq: number;
  readonly role: "human" | "agent";
  readonly text: string;
  readonly annotationCount: number;
}

/** One frame of the stream, by what it tells the page. */
export type LiveFrame =
  | { readonly _tag: "PresenceChanged"; readonly presence: Presence }
  | ({ readonly _tag: "ConversationAppended" } & ConversationEntry)
  | { readonly _tag: "ArtifactReloaded"; readonly version: string }
  | { readonly _tag: "SessionEnded" };

const isPresence = (value: unknown): value is Presence =>
  value === "idle" || value === "listening" || value === "working";

const isConversationEntry = (value: unknown): value is ConversationEntry =>
  typeof value === "object" &&
  value !== null &&
  "seq" in value &&
  typeof value.seq === "number" &&
  "role" in value &&
  (value.role === "human" || value.role === "agent") &&
  "text" in value &&
  typeof value.text === "string" &&
  "annotationCount" in value &&
  typeof value.annotationCount === "number";

/** The frame an SSE `message` event's `data` holds, or `null` for anything else. */
export const parseLiveFrame = (data: string): LiveFrame | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("_tag" in parsed)) {
    return null;
  }
  if (
    parsed._tag === "PresenceChanged" &&
    "presence" in parsed &&
    isPresence(parsed.presence)
  ) {
    return { _tag: "PresenceChanged", presence: parsed.presence };
  }
  if (parsed._tag === "ConversationAppended" && isConversationEntry(parsed)) {
    const { seq, role, text, annotationCount } = parsed;
    return { _tag: "ConversationAppended", seq, role, text, annotationCount };
  }
  if (
    parsed._tag === "ArtifactReloaded" &&
    "version" in parsed &&
    typeof parsed.version === "string"
  ) {
    return { _tag: "ArtifactReloaded", version: parsed.version };
  }
  if (parsed._tag === "SessionEnded") {
    return { _tag: "SessionEnded" };
  }
  return null;
};

/**
 * How a Conversation bubble reads: an annotation-only Feedback carries an empty
 * message, so it reads as its annotation count, never as a blank bubble.
 */
export const bubbleText = (
  entry: ConversationEntry,
): { readonly text: string; readonly countOnly: boolean } =>
  entry.text.trim().length === 0 && entry.annotationCount > 0
    ? {
        text: `${entry.annotationCount} annotation${
          entry.annotationCount === 1 ? "" : "s"
        }`,
        countOnly: true,
      }
    : { text: entry.text, countOnly: false };

/** Each Conversation role's label on its bubble. */
export const roleLabel = { human: "Human", agent: "Agent" } as const;

/** What a page does with each frame of a Session's stream. */
export interface LiveHandlers {
  readonly setPresence: (presence: Presence) => void;
  readonly appendConversation: (entry: ConversationEntry) => void;
  readonly reload: (version: string) => void;
  readonly ended: () => void;
}

/**
 * Open the Session's SSE stream at `url` and hand each valid frame to its
 * handler. `EventSource` reconnects on its own and resumes the Conversation from
 * `Last-Event-ID`, so a dropped connection never doubles a bubble. On
 * `SessionEnded` the page closes its stream, which ends the daemon's side too
 * (ADR 0011).
 */
export const followLiveFrames = (url: string, handlers: LiveHandlers): void => {
  const source = new EventSource(url);
  source.addEventListener("message", (event) => {
    const frame = parseLiveFrame(event.data);
    if (frame === null) {
      return;
    }
    switch (frame._tag) {
      case "PresenceChanged":
        handlers.setPresence(frame.presence);
        break;
      case "ConversationAppended":
        handlers.appendConversation(frame);
        break;
      case "ArtifactReloaded":
        handlers.reload(frame.version);
        break;
      case "SessionEnded":
        handlers.ended();
        source.close();
        break;
    }
  });
};
