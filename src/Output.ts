import { Option } from "effect";
import type { Annotation, Feedback } from "./Protocol.ts";

/**
 * Pure output shaping for intervu's CLI.
 *
 * Commands build plain JS views with these shapers, render them to TOON via
 * `Toon.encode`, and write through the single `emit` boundary at the CLI. Keep
 * this module free of effects and IO: every function is a total transformation
 * from inputs to a serializable view, so renders stay deterministic and unit
 * testable.
 */

/**
 * A live Session as it appears in the home view, in canonical key order: `key`,
 * `path`, `status`. `path` is the handle every command takes, so the home view
 * carries it for the agent to `poll` (ADR 0013).
 */
export interface SessionSummary {
  readonly key: string;
  readonly path: string;
  readonly status: string;
}

/**
 * The content-first home view shown on bare `intervu` invocation, in canonical
 * key order: `bin`, `description`, `sessions`, `help`.
 */
export interface HomeView {
  readonly bin: string;
  readonly description: string;
  readonly sessions: readonly SessionSummary[];
  readonly help: string;
}

/**
 * Shape the home view, pinning key order so the TOON render is stable
 * regardless of how the caller ordered its fields - including each session row's
 * `{key, path, status}` order.
 */
export const home = (params: HomeView): HomeView => ({
  bin: params.bin,
  description: params.description,
  sessions: params.sessions.map((session) => ({
    key: session.key,
    path: session.path,
    status: session.status,
  })),
  help: params.help,
});

/**
 * A Session as printed by `open`, in canonical key order: `key`, `path`,
 * `status`, `help`.
 */
export interface SessionView {
  readonly key: string;
  readonly path: string;
  readonly status: string;
  readonly help: string;
}

/**
 * Shape the Session view, pinning key order so the TOON render is stable
 * regardless of how the caller ordered its fields.
 */
export const session = (params: SessionView): SessionView => ({
  key: params.key,
  path: params.path,
  status: params.status,
  help: params.help,
});

/**
 * A URL-mode Session as printed by `open <url>` (ADR 0022), in canonical key
 * order: `key`, `origin`, `status`, then - only when there is something to
 * say - `warning` (an origin no browser will report) and `didYouMean` (a
 * browser is waiting at another origin), then `help`. `origin` is the handle
 * every later command takes for this Session.
 */
export interface AppSessionView {
  readonly key: string;
  readonly origin: string;
  readonly status: string;
  readonly warning?: string;
  readonly didYouMean?: string;
  readonly help: string;
}

/** Shape the URL-mode Session view, pinning key order. */
export const appSession = (params: {
  readonly key: string;
  readonly origin: string;
  readonly status: string;
  readonly warning?: string | undefined;
  readonly didYouMean?: string | undefined;
  readonly help: string;
}): AppSessionView => ({
  key: params.key,
  origin: params.origin,
  status: params.status,
  ...(params.warning === undefined ? {} : { warning: params.warning }),
  ...(params.didYouMean === undefined ? {} : { didYouMean: params.didYouMean }),
  help: params.help,
});

/**
 * One annotation as the poll prints it: `n` is the 1-based badge number the
 * human saw, then the selector context. `selectedText` is present only on the
 * `text` kind, so the key is omitted entirely for an `element` annotation.
 * `source` (the JSX `file:line:col`) and `pageUrl` come only from a live app in
 * URL mode, and are likewise omitted when absent.
 */
export interface PollAnnotationView {
  readonly n: number;
  readonly kind: string;
  readonly selector: string;
  readonly tag: string;
  readonly text: string;
  readonly selectedText?: string;
  readonly source?: string;
  readonly pageUrl?: string;
}

/**
 * One drained Feedback: the human's message, its numbered annotations, and where
 * to find the DOM snapshot (ADR 0021). Normally that is a file path; the snapshot
 * itself appears inline only if the file could not be written.
 */
export type PollFeedbackView =
  | {
      readonly message: string;
      readonly redacted?: true;
      readonly annotations: readonly PollAnnotationView[];
      readonly domSnapshotPath: string;
    }
  | {
      readonly message: string;
      readonly redacted?: true;
      readonly annotations: readonly PollAnnotationView[];
      readonly domSnapshot: string;
    };

/** A drained Feedback and the file its snapshot was saved to, if it was saved. */
export interface DeliveredFeedback {
  readonly feedback: Feedback;
  readonly snapshotPath: Option.Option<string>;
}

/** The poll's feedback document: the drained collection plus a next-step line. */
export interface PollView {
  readonly feedback: readonly PollFeedbackView[];
  readonly help: string;
}

/** The poll's distinct expiry document, emitted only when `--timeout` is set. */
export interface PollTimedOutView {
  readonly timedOut: true;
  readonly help: string;
}

/**
 * The poll's ended document (ADR 0011): the Session closed. Carries any final
 * feedback the human sent with Send & end (empty for a plain End), so the agent
 * applies the last edit and stops in one poll.
 */
export interface PollEndedView {
  readonly ended: true;
  readonly feedback: readonly PollFeedbackView[];
  readonly help: string;
}

const shapeAnnotation = (
  annotation: Annotation,
  index: number,
): PollAnnotationView => {
  const base = {
    n: index + 1,
    kind: annotation.kind,
    selector: annotation.selector,
    tag: annotation.tag,
    text: annotation.text,
  };
  return {
    ...base,
    ...(annotation.kind === "text"
      ? { selectedText: annotation.selectedText }
      : {}),
    ...(annotation.source === undefined ? {} : { source: annotation.source }),
    ...(annotation.pageUrl === undefined
      ? {}
      : { pageUrl: annotation.pageUrl }),
  };
};

const shapeFeedback = ({
  feedback,
  snapshotPath,
}: DeliveredFeedback): PollFeedbackView => {
  const base = {
    message: feedback.message,
    // Marked so the agent knows the masked placeholders are deliberate.
    ...(feedback.redacted === true ? { redacted: true as const } : {}),
    annotations: feedback.annotations.map(shapeAnnotation),
  };
  return Option.match(snapshotPath, {
    onNone: (): PollFeedbackView => ({
      ...base,
      domSnapshot: feedback.domSnapshot,
    }),
    onSome: (domSnapshotPath): PollFeedbackView => ({
      ...base,
      domSnapshotPath,
    }),
  });
};

/**
 * Shape the poll's drained feedback into its view, pinning the canonical order
 * (`feedback`, then `help`) so the TOON render is stable.
 */
export const pollFeedback = (params: {
  readonly feedback: readonly DeliveredFeedback[];
  readonly help: string;
}): PollView => ({
  feedback: params.feedback.map(shapeFeedback),
  help: params.help,
});

/** Shape the poll's bounded-timeout expiry into its distinct view. */
export const pollTimedOut = (params: {
  readonly help: string;
}): PollTimedOutView => ({
  timedOut: true,
  help: params.help,
});

/**
 * Shape the poll's ended outcome (ADR 0011), pinning the canonical order
 * (`ended`, `feedback`, then `help`) so the TOON render is stable. The agent
 * applies any final feedback, sees `ended`, and stops.
 */
export const pollEnded = (params: {
  readonly feedback: readonly DeliveredFeedback[];
  readonly help: string;
}): PollEndedView => ({
  ended: true,
  feedback: params.feedback.map(shapeFeedback),
  help: params.help,
});

/** A view for `intervu end <file>`: the Session is ended. */
export interface EndedView {
  readonly ended: true;
  readonly help: string;
}

/** Shape the `intervu end` confirmation into its view. */
export const ended = (params: { readonly help: string }): EndedView => ({
  ended: true,
  help: params.help,
});

/** A view for `intervu reply <file> <message>`: whether the reply posted. */
export interface RepliedView {
  readonly posted: boolean;
  readonly help: string;
}

/** Shape the `intervu reply` outcome into its view. */
export const replied = (params: {
  readonly posted: boolean;
  readonly help: string;
}): RepliedView => ({
  posted: params.posted,
  help: params.help,
});

/**
 * One artifact of `intervu setup`: what happened to it (`installed` or
 * `already-present`) and where it landed, in canonical key order. Used for both
 * the Skill and the Hook.
 */
export interface SetupArtifactView {
  readonly action: string;
  readonly path: string;
}

/**
 * The `setup` view, in canonical key order: `skill`, `hook`, then `help`. Each
 * artifact key is present only when that half was in scope (issue #15), so a
 * `--skill-only` / `--hooks-only` run reports just the half it wired.
 */
export interface SetupView {
  readonly skill?: SetupArtifactView;
  readonly hook?: SetupArtifactView;
  readonly help: string;
}

/**
 * Shape the `setup` result, pinning key order so the TOON render is stable
 * regardless of how the caller ordered its fields. An out-of-scope half is
 * passed as `undefined` and omitted from the view entirely.
 */
export const setup = (params: {
  readonly skill?:
    | { readonly action: string; readonly path: string }
    | undefined;
  readonly hook?:
    | { readonly action: string; readonly path: string }
    | undefined;
  readonly help: string;
}): SetupView => ({
  ...(params.skill
    ? { skill: { action: params.skill.action, path: params.skill.path } }
    : {}),
  ...(params.hook
    ? { hook: { action: params.hook.action, path: params.hook.path } }
    : {}),
  help: params.help,
});

/** One Session as `intervu status` prints it, in canonical key order. */
export interface StatusSessionView {
  readonly key: string;
  readonly kind: string;
  readonly handle: string;
  readonly status: string;
  readonly presence: string;
  readonly lastActivityAt?: string;
}

/** One reporting plugin as `intervu status` prints it. */
export interface StatusPluginView {
  readonly origin: string;
  readonly seenOrigins: readonly string[];
  readonly lastSeenAt: string;
}

/**
 * One refusal tally as `intervu status` prints it: which plugin tallied it,
 * the rejection reason, and the origins the refused request presented
 * (omitted when it presented none).
 */
export interface StatusRefusalView {
  readonly plugin: string;
  readonly reason: string;
  readonly origin?: string;
  readonly pageOrigin?: string;
  readonly count: number;
  readonly lastAt: string;
}

/** One waiting origin as `intervu status` prints it. */
export interface StatusWaitingView {
  readonly origin: string;
  readonly count: number;
  readonly lastSeenAt: string;
}

/**
 * The `intervu status` view, in canonical key order: the daemon describing
 * itself, its Sessions with Presence, the reporting plugins, their refusal
 * tallies, the waiting origins, then `help`.
 */
export interface StatusView {
  readonly version: string;
  readonly port: number;
  readonly stateDir: string;
  readonly sessions: readonly StatusSessionView[];
  readonly plugins: readonly StatusPluginView[];
  readonly refusals: readonly StatusRefusalView[];
  readonly waitingOrigins: readonly StatusWaitingView[];
  readonly help: string;
}

/** An epoch-milliseconds stamp as the ISO-8601 string status prints. */
const isoOf = (epochMs: number): string => new Date(epochMs).toISOString();

/**
 * Shape the `status` view from the daemon's answer, pinning key order so the
 * TOON render is stable. Refusal tallies are flattened across plugins, each
 * row naming the plugin that tallied it.
 */
export const status = (params: {
  readonly version: string;
  readonly port: number;
  readonly stateDir: string;
  readonly sessions: readonly {
    readonly key: string;
    readonly kind: string;
    readonly handle: string;
    readonly status: string;
    readonly presence: string;
    readonly lastActivityAt?: number | undefined;
  }[];
  readonly plugins: readonly {
    readonly origin: string;
    readonly seenOrigins: readonly string[];
    readonly refusals: readonly {
      readonly reason: string;
      readonly origin?: string | undefined;
      readonly pageOrigin?: string | undefined;
      readonly count: number;
      readonly lastAt: number;
    }[];
    readonly lastSeenAt: number;
  }[];
  readonly waitingOrigins: readonly {
    readonly origin: string;
    readonly count: number;
    readonly lastSeenAt: number;
  }[];
  readonly help: string;
}): StatusView => ({
  version: params.version,
  port: params.port,
  stateDir: params.stateDir,
  sessions: params.sessions.map((session) => ({
    key: session.key,
    kind: session.kind,
    handle: session.handle,
    status: session.status,
    presence: session.presence,
    ...(session.lastActivityAt === undefined
      ? {}
      : { lastActivityAt: isoOf(session.lastActivityAt) }),
  })),
  plugins: params.plugins.map((plugin) => ({
    origin: plugin.origin,
    seenOrigins: plugin.seenOrigins,
    lastSeenAt: isoOf(plugin.lastSeenAt),
  })),
  refusals: params.plugins.flatMap((plugin) =>
    plugin.refusals.map((refusal) => ({
      plugin: plugin.origin,
      reason: refusal.reason,
      ...(refusal.origin === undefined ? {} : { origin: refusal.origin }),
      ...(refusal.pageOrigin === undefined
        ? {}
        : { pageOrigin: refusal.pageOrigin }),
      count: refusal.count,
      lastAt: isoOf(refusal.lastAt),
    })),
  ),
  waitingOrigins: params.waitingOrigins.map((waiting) => ({
    origin: waiting.origin,
    count: waiting.count,
    lastSeenAt: isoOf(waiting.lastSeenAt),
  })),
  help: params.help,
});

/** One doctor check as `intervu doctor` prints it, hint only on failure. */
export interface DoctorCheckView {
  readonly check: string;
  readonly result: string;
  readonly detail: string;
  readonly hint?: string;
}

/**
 * The `intervu doctor <url>` view, in canonical key order: the URL and
 * origin it diagnosed, the five checks in the order they run, then `help`.
 */
export interface DoctorView {
  readonly url: string;
  readonly origin: string;
  readonly checks: readonly DoctorCheckView[];
  readonly help: string;
}

/** Shape the doctor's verdicts, pinning check order and key order. */
export const doctor = (params: {
  readonly url: string;
  readonly origin: string;
  readonly checks: readonly {
    readonly check: string;
    readonly result: string;
    readonly detail: string;
    readonly hint?: string | undefined;
  }[];
  readonly help: string;
}): DoctorView => ({
  url: params.url,
  origin: params.origin,
  checks: params.checks.map((check) => ({
    check: check.check,
    result: check.result,
    detail: check.detail,
    ...(check.hint === undefined ? {} : { hint: check.hint }),
  })),
  help: params.help,
});

/** The `status` view when no daemon answered on the port(s). */
export interface StatusNoDaemonView {
  readonly daemon: "none";
  readonly port: number;
  readonly stateDir: string;
  readonly help: string;
}

/** Shape the no-daemon `status` view; it still names the state dir in use. */
export const statusNoDaemon = (params: {
  readonly port: number;
  readonly stateDir: string;
  readonly help: string;
}): StatusNoDaemonView => ({
  daemon: "none",
  port: params.port,
  stateDir: params.stateDir,
  help: params.help,
});

/**
 * The `intervu setup vite` view, in canonical key order: what happened to
 * the written plugin file, where it landed, the exact import line and
 * config edit for `vite.config.ts` - the one edit that stays human - then
 * `help`.
 */
export interface SetupViteView {
  readonly action: string;
  readonly path: string;
  readonly importLine: string;
  readonly configEdit: string;
  readonly help: string;
}

/** Shape the `setup vite` result, pinning key order. */
export const setupVite = (params: SetupViteView): SetupViteView => ({
  action: params.action,
  path: params.path,
  importLine: params.importLine,
  configEdit: params.configEdit,
  help: params.help,
});

/**
 * A structured error view. Errors are success-only here - the failure path is
 * wired in the AXI-polish slice (#9) - but the shape is the seam they land on.
 */
export interface ErrorView {
  readonly error: {
    readonly tag: string;
    readonly message: string;
  };
  readonly help: string;
}

/**
 * Shape a structured error into its view.
 */
export const error = (params: {
  readonly tag: string;
  readonly message: string;
  readonly help: string;
}): ErrorView => ({
  error: { tag: params.tag, message: params.message },
  help: params.help,
});

/**
 * Merge two view fragments into one, with `extra` winning on key conflicts.
 * Used to graft a trailing fragment (a `help` line, an error block) onto a
 * content view before rendering.
 */
export const merge = <A extends object, B extends object>(
  base: A,
  extra: B,
): A & B => ({ ...base, ...extra });
