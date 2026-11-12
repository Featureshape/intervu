import { hasField } from "../hasField.ts";
import { createAnnotator } from "../sdk/annotator.ts";
import { annotationToWire } from "../sdk/feedbackWire.ts";
import {
  bubbleText,
  type ConversationEntry,
  followLiveFrames,
  type Presence,
  roleLabel,
} from "../sdk/liveFrame.ts";
import type { Annotation } from "../sdk/protocol.ts";
import { sourceAttribute, sourceRegistryKey } from "../vite/jsxSource.ts";
import {
  ownMarkupAttribute,
  relayPrefix,
  sessionPath,
} from "../vite/relayPaths.ts";
import { classifyLookup, type LookupState } from "./lookupState.ts";
import {
  maskText,
  redactAttribute,
  redactCapturedText,
  redactSnapshot,
} from "./redact.ts";
import { trimSnapshot } from "./snapshot.ts";
import {
  readDraft,
  readPosition,
  type TabStorage,
  writeDraft,
  writePosition,
} from "./tabMemory.ts";

/**
 * The in-page overlay for URL mode: the `intervu/vite` plugin injects this
 * script into the running app's own document. Everything it renders lives in
 * one shadow root, so the app's CSS cannot reach it and its CSS cannot leak into
 * the app (the same encapsulation as the artifact marker overlay, ADR 0005).
 * The shadow host is a manual popover shown in the browser's top layer, so no
 * `z-index` in the app can paint over it.
 *
 * With no Session open for the origin the overlay rests as the dormant badge:
 * a small "intervu: no agent" pill whose click reveals the command to hand the
 * agent. Meanwhile it asks the plugin's relay once a second whether a Session
 * has opened; the relay answers "none" itself when no daemon runs, so a stopped
 * daemon leaves the app's console clean. Once a Session is open the badge gives
 * way to the floating panel, in place, without a page reload.
 *
 * The panel runs Annotate-mode in the app's own document (the SDK's capture
 * loop, without the Bridge: panel and app share one document). Each annotation
 * also records the page it was made on and the JSX `file:line:col` of the
 * nearest element the app's own code rendered, read from the plugin's
 * `data-intervu-src` stamp. Send posts the message, the pending annotations and
 * a DOM snapshot without intervu's own markup to the Session through the relay.
 *
 * The panel reads the Session's SSE stream through the relay too, so every tab
 * open on the origin renders the same Conversation, the agent's Presence and the
 * ended state from the daemon, as the artifact chrome does (ADR 0010, 0011).
 *
 * Vite's HMR swaps the app's modules under the panel without touching it, so
 * the Conversation, the pending annotations and the panel's place survive an
 * edit. A full page reload starts the panel afresh: the unsent message and the
 * place the panel was dragged to come back from the tab's `sessionStorage`.
 */

const STYLES = `
  :host {
    all: initial;
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 2147483647;
    font: 400 12px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif;
    color: #1a1a1f;
  }
  .root {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 10px;
    box-sizing: border-box;
    border: 0;
    border-radius: 13px;
    background: #1a1a1f;
    color: #ffffff;
    font: 500 12px/1 ui-sans-serif, system-ui, -apple-system, sans-serif;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12), 0 4px 12px rgba(0, 0, 0, 0.12);
    cursor: pointer;
  }
  .badge:hover { background: #2e2e35; }
  .badge:focus-visible { outline: 2px solid #6b6b76; outline-offset: 2px; }
  .dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #8b8b96;
  }
  .badge[data-intervu-badge="refused"] .dot { background: #e5484d; }
  .card {
    width: 288px;
    padding: 12px;
    box-sizing: border-box;
    border: 1px solid #e4e4e7;
    border-radius: 8px;
    background: #ffffff;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 8px 24px rgba(0, 0, 0, 0.12);
  }
  .card[hidden] { display: none; }
  .title {
    margin: 0 0 4px;
    font-weight: 600;
  }
  .hint {
    margin: 0 0 8px;
    color: #6b6b76;
  }
  .command {
    display: block;
    padding: 6px 8px;
    border-radius: 6px;
    background: #f4f4f5;
    font: 400 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow-wrap: anywhere;
    user-select: all;
  }
  .panel {
    display: flex;
    flex-direction: column;
    width: 320px;
    max-height: min(480px, calc(100vh - 32px));
    box-sizing: border-box;
    border: 1px solid #e2e2e6;
    border-radius: 10px;
    background: #fcfcfd;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 12px 32px rgba(0, 0, 0, 0.16);
    overflow: hidden;
  }
  .header {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    height: 40px;
    padding: 0 6px 0 12px;
    box-sizing: border-box;
    background: #fafafa;
    cursor: grab;
    touch-action: none;
    user-select: none;
  }
  .panel[data-dragging] .header { cursor: grabbing; }
  .panel:not([data-collapsed]) .header { border-bottom: 1px solid #e2e2e6; }
  .brand {
    flex: none;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .origin {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    color: #6b6b76;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .presence {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 6px;
    color: #6b6b76;
    font-size: 12px;
  }
  .presence[hidden] { display: none; }
  .dot[data-presence="idle"] { background: #a1a1aa; }
  .dot[data-presence="listening"] { background: #10b981; }
  .dot[data-presence="working"] { background: #f59e0b; }
  .ended-pill {
    flex: none;
    padding: 2px 8px;
    border-radius: 9px;
    background: #f2f2f4;
    color: #6b6b76;
    font-size: 12px;
    font-weight: 500;
  }
  .ended-pill[hidden] { display: none; }
  .collapse {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: #6b6b76;
    cursor: pointer;
  }
  .collapse:hover { background: #f2f2f4; color: #1a1a1f; }
  .collapse:focus-visible { outline: 2px solid #6b6b76; outline-offset: -2px; }
  .collapse svg { transition: transform 120ms ease; }
  .panel[data-collapsed] .collapse svg { transform: rotate(180deg); }
  .body {
    min-height: 0;
    flex: 1;
    padding: 16px;
    overflow-y: auto;
  }
  .body[hidden] { display: none; }
  .heading {
    margin: 0 0 8px;
    color: #6b6b76;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .empty {
    margin: 0;
    color: #6b6b76;
    font-size: 13px;
    line-height: 1.6;
  }
  .empty[hidden] { display: none; }
  .section + .section { margin-top: 16px; }
  .bubbles {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .bubbles:empty { display: none; }
  .bubble {
    max-width: 85%;
    padding: 6px 10px;
    box-sizing: border-box;
    border-radius: 8px;
    font-size: 13px;
    line-height: 1.6;
  }
  .bubble[data-role="human"] {
    align-self: flex-end;
    background: #1a1a1f;
    color: #ffffff;
  }
  .bubble[data-role="agent"] {
    align-self: flex-start;
    background: #f2f2f4;
    color: #1a1a1f;
  }
  .role {
    display: block;
    margin-bottom: 2px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    opacity: 0.7;
  }
  .said {
    margin: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .said[data-count-only] {
    font-style: italic;
    opacity: 0.8;
  }
  .pending {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .pending[hidden] { display: none; }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 8px;
    border: 1px solid #e2e2e6;
    border-radius: 6px;
    background: #ffffff;
    font-size: 13px;
  }
  .number {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    margin-top: 1px;
    padding: 0 5px;
    box-sizing: border-box;
    border-radius: 9px;
    background: #1a1a1f;
    color: #ffffff;
    font-size: 11px;
    font-weight: 600;
  }
  .target {
    min-width: 0;
    flex: 1;
  }
  .tag {
    display: block;
    font: 400 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .detail {
    display: block;
    overflow: hidden;
    color: #6b6b76;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .remove {
    flex: none;
    padding: 0 4px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: #6b6b76;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
  }
  .remove:hover { color: #1a1a1f; }
  .remove:focus-visible { outline: 2px solid #6b6b76; outline-offset: 1px; }
  .composer {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border-top: 1px solid #e2e2e6;
    background: #ffffff;
  }
  .composer[hidden] { display: none; }
  .send-status {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .send-status[hidden] { display: none; }
  .send-status[data-tone="error"] { color: #b42318; }
  .send-status[data-tone="warning"] { color: #6b6b76; }
  .ended-note {
    flex: none;
    margin: 0;
    padding: 12px;
    border-top: 1px solid #e2e2e6;
    background: #ffffff;
    color: #6b6b76;
    font-size: 13px;
    font-style: italic;
    line-height: 1.6;
  }
  .ended-note[hidden] { display: none; }
  .input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    border: 1px solid #e2e2e6;
    border-radius: 6px;
    background: #ffffff;
    color: #1a1a1f;
    font: 400 13px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
    resize: none;
    outline: none;
  }
  .input::placeholder { color: #6b6b76; }
  .input:focus { border-color: #1a1a1f; }
  .actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .button {
    height: 30px;
    padding: 0 12px;
    box-sizing: border-box;
    border: 1px solid #e2e2e6;
    border-radius: 6px;
    background: #ffffff;
    color: #1a1a1f;
    font: 500 13px/1 ui-sans-serif, system-ui, -apple-system, sans-serif;
    cursor: pointer;
  }
  .button:hover { background: #f2f2f4; }
  .button:focus-visible { outline: 2px solid #6b6b76; outline-offset: 2px; }
  .button[aria-pressed="true"],
  .button.primary {
    border-color: #1a1a1f;
    background: #1a1a1f;
    color: #ffffff;
  }
  .button[aria-pressed="true"]:hover,
  .button.primary:hover { background: #2e2e35; }
  .button:disabled {
    cursor: default;
    opacity: 0.5;
  }
  .button.primary:disabled:hover { background: #1a1a1f; }
`;

/**
 * The relay URL of `path`, naming the page's own origin. The browser's
 * `location.origin` is the one origin that stays right when a proxy in front of
 * the dev server terminates TLS or changes the port, so the relay looks the
 * Session up by it rather than by what the dev server sees.
 */
const relayUrl = (path: string): string =>
  `${relayPrefix}${path}?${new URLSearchParams({ origin: window.location.origin })}`;

/**
 * The tab's `sessionStorage`, read on each use: a browser that refuses storage
 * throws from the access itself, and `./tabMemory.ts` treats that as no memory.
 */
const tabStorage: TabStorage = {
  getItem: (key) => window.sessionStorage.getItem(key),
  setItem: (key, value) => window.sessionStorage.setItem(key, value),
  removeItem: (key) => window.sessionStorage.removeItem(key),
};

/** How often the dormant badge asks whether a Session has opened. */
const sessionLookupIntervalMs = 1_000;

/**
 * Whether the app owner's plugin config redacts the whole page
 * (`intervu({ redact: true })`). The plugin bakes it into this script's own
 * URL, so it is the owner's switch: nothing the agent or the CLI sends can
 * turn it off.
 */
const fullRedact = new URL(import.meta.url).searchParams.get("redact") === "1";

/** The command that opens a URL-mode Session for this page's origin. */
const openCommand = (): string => `intervu ${window.location.origin}`;

/**
 * Ask the relay which Session is open for this origin, classified for the
 * badge. A dev server that stopped answering is "not yet": the next ask tries
 * again.
 */
const lookupSessionState = async (): Promise<LookupState> => {
  try {
    const response = await fetch(relayUrl(sessionPath), { cache: "no-store" });
    return classifyLookup(response.status, await response.json());
  } catch {
    return { kind: "no-session" };
  }
};

/** The lookup states the dormant badge renders; "open" swaps in the panel. */
type DormantState = Exclude<LookupState, { kind: "open" }>;

/**
 * Ask once a second until a Session is open, then call `onOpen` once with its
 * key. Until then each ask reports its state through `onState`, so the badge
 * can say what it last heard.
 */
const watchForSession = (
  onOpen: (key: string) => void,
  onState?: (state: DormantState) => void,
): void => {
  const ask = (): void => {
    lookupSessionState().then((state) => {
      if (state.kind === "open") {
        onOpen(state.key);
      } else {
        onState?.(state);
        window.setTimeout(ask, sessionLookupIntervalMs);
      }
    });
  };
  ask();
};

/** A paragraph of the dormant card, with an optional data hook. */
const cardLine = (
  className: string,
  text: string,
  hook?: string,
): HTMLParagraphElement => {
  const line = document.createElement("p");
  line.className = className;
  line.textContent = text;
  if (hook !== undefined) {
    line.setAttribute(hook, "");
  }
  return line;
};

/** The dormant card's contents for `state`: what the last lookup said. */
const cardContentOf = (state: DormantState): readonly HTMLElement[] => {
  if (state.kind === "refused") {
    return [
      cardLine("title", "The dev server refused intervu's request"),
      cardLine("hint", state.reason, "data-intervu-refusal-reason"),
      cardLine(
        "hint",
        `Page origin: ${state.pageOrigin ?? window.location.origin}`,
        "data-intervu-refused-origin",
      ),
      cardLine("hint", "The dev server log has the full comparison."),
    ];
  }
  const command = document.createElement("code");
  command.className = "command";
  command.setAttribute("data-intervu-command", "");
  command.textContent = openCommand();
  if (state.kind === "no-daemon") {
    return [
      cardLine("title", "No intervu daemon answered"),
      cardLine(
        "hint",
        `The dev server found no daemon on port ${state.ports.join(", ")}.`,
        "data-intervu-no-daemon",
      ),
      cardLine("hint", "Ask your agent to run:"),
      command,
    ];
  }
  return [
    cardLine("title", "No agent is reviewing this app"),
    cardLine("hint", "Ask your agent to run:"),
    command,
  ];
};

/**
 * The dormant badge and the card its click reveals. Returns the updater that
 * renders what the last lookup said: no Session, no daemon behind the dev
 * server, or a dev server that refused the page.
 */
const renderDormantBadge = (
  root: HTMLElement,
): ((state: DormantState) => void) => {
  root.replaceChildren();

  const card = document.createElement("div");
  card.className = "card";
  card.id = "intervu-dormant-card";
  card.hidden = true;
  card.setAttribute("data-intervu-dormant-card", "");

  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = "badge";
  badge.setAttribute("aria-expanded", "false");
  badge.setAttribute("aria-controls", card.id);

  const dot = document.createElement("span");
  dot.className = "dot";
  dot.setAttribute("aria-hidden", "true");

  let rendered = "";
  const update = (state: DormantState): void => {
    const stamp = JSON.stringify(state);
    if (stamp === rendered) {
      return;
    }
    rendered = stamp;
    const refused = state.kind === "refused";
    badge.setAttribute("data-intervu-badge", refused ? "refused" : "dormant");
    badge.replaceChildren(
      dot,
      refused ? "intervu: refused by dev server" : "intervu: no agent",
    );
    card.replaceChildren(...cardContentOf(state));
  };
  update({ kind: "no-session" });

  const setOpen = (open: boolean): void => {
    card.hidden = !open;
    badge.setAttribute("aria-expanded", String(open));
  };
  badge.addEventListener("click", () => setOpen(card.hidden));
  const closeOnEscape = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      setOpen(false);
    }
  };
  card.addEventListener("keydown", closeOnEscape);
  badge.addEventListener("keydown", closeOnEscape);

  root.append(card, badge);
  return update;
};

/** The chevron the collapse button shows, pointing down while expanded. */
const chevron = (): SVGSVGElement => {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M4 6l4 4 4-4");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
};

/** Keep `value` within `[0, max]`, preferring `0` when the room is negative. */
const clamp = (value: number, max: number): number =>
  Math.max(0, Math.min(value, max));

/**
 * Let the human drag the panel by its header. The host moves, not the panel:
 * from the first drag on it is placed by `left`/`top` instead of the corner it
 * starts in, and kept inside the viewport, including when the window shrinks.
 * Where a drag leaves it is kept for the tab, so the panel starts there after a
 * reload.
 */
const makeDraggable = (
  host: HTMLElement,
  panel: HTMLElement,
  handle: HTMLElement,
  lifetime: AbortSignal,
): void => {
  let placed = false;

  const placeAt = (left: number, top: number): void => {
    const box = host.getBoundingClientRect();
    host.style.left = `${clamp(left, window.innerWidth - box.width)}px`;
    host.style.top = `${clamp(top, window.innerHeight - box.height)}px`;
    host.style.right = "auto";
    host.style.bottom = "auto";
    placed = true;
  };

  handle.addEventListener("pointerdown", (event) => {
    if (
      event.button !== 0 ||
      (event.target instanceof Element && event.target.closest("button"))
    ) {
      return;
    }
    event.preventDefault();
    const start = host.getBoundingClientRect();
    const offsetX = event.clientX - start.left;
    const offsetY = event.clientY - start.top;
    handle.setPointerCapture(event.pointerId);
    panel.setAttribute("data-dragging", "");

    const move = (moved: PointerEvent): void =>
      placeAt(moved.clientX - offsetX, moved.clientY - offsetY);
    const stop = (): void => {
      panel.removeAttribute("data-dragging");
      if (placed) {
        const box = host.getBoundingClientRect();
        writePosition(tabStorage, { left: box.left, top: box.top });
      }
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  });

  window.addEventListener(
    "resize",
    () => {
      if (placed) {
        const box = host.getBoundingClientRect();
        placeAt(box.left, box.top);
      }
    },
    { signal: lifetime },
  );

  const stored = readPosition(tabStorage);
  if (stored !== null) {
    placeAt(stored.left, stored.top);
  }
};

/**
 * An annotation made on the live app: the SDK's annotation plus the page it
 * was made on and, when the app's own JSX rendered the target or an ancestor,
 * that element's `file:line:col`.
 */
interface AppAnnotation {
  readonly annotation: Annotation;
  readonly source: string | null;
  readonly pageUrl: string;
}

/** The React fiber that rendered `node`, from React's dev expando, if any. */
const fiberOf = (node: Element): unknown => {
  const key = Object.keys(node).find((name) =>
    name.startsWith("__reactFiber$"),
  );
  return key === undefined ? undefined : Reflect.get(node, key);
};

/**
 * The call sites the app's JSX gave its component elements, keyed by the
 * element's props object, as the plugin's `jsxDEV` wrapper records them; a
 * fiber's `memoizedProps` is that same object.
 */
const componentSources = (): WeakMap<object, string> | null => {
  const registry: unknown = Reflect.get(
    globalThis,
    Symbol.for(sourceRegistryKey),
  );
  return registry instanceof WeakMap ? registry : null;
};

/**
 * The JSX source of the nearest element above `anchor` the app's code wrote:
 * an intrinsic element's own `data-intervu-src`, or the call site of a
 * component element. It walks React's own tree, from `anchor` up through the
 * fibers that rendered it, so an `<h1>` a third-party `<PageHeader>` renders
 * names the app's `<PageHeader>` call, and content a third-party component
 * portals to `<body>` still names the app element that renders that component.
 * The DOM's ancestors answer for anything React did not render.
 */
const sourceOf = (anchor: Element): string | null => {
  const registry = componentSources();
  let fiber = fiberOf(anchor);
  while (hasField(fiber, "memoizedProps")) {
    const props = fiber.memoizedProps;
    if (
      hasField(props, sourceAttribute) &&
      typeof props[sourceAttribute] === "string"
    ) {
      return props[sourceAttribute];
    }
    const callSite =
      typeof props === "object" && props !== null
        ? registry?.get(props)
        : undefined;
    if (callSite !== undefined) {
      return callSite;
    }
    fiber = hasField(fiber, "return") ? fiber.return : null;
  }
  return (
    anchor.closest(`[${sourceAttribute}]`)?.getAttribute(sourceAttribute) ??
    null
  );
};

/** An annotation's wire shape, with the live app's source and page. */
const toWire = ({ annotation, source, pageUrl }: AppAnnotation) => ({
  ...annotationToWire(annotation),
  ...(source === null ? {} : { source }),
  pageUrl,
});

/**
 * The app's DOM as the human sees it, without intervu: the overlay's host, the
 * annotation markers' host and the plugin's overlay script are dropped from a
 * copy, so the snapshot the agent reads is the app's own markup, and the copy
 * is trimmed to what an agent reads (`./snapshot.ts`).
 */
const appSnapshot = (): string => {
  const copy = document.importNode(document.documentElement, true);
  for (const own of copy.querySelectorAll(`[${ownMarkupAttribute}]`)) {
    own.remove();
  }
  trimSnapshot(copy);
  // Masking happens here, in the browser, before anything leaves the page:
  // the whole copy under the owner's `redact: true`, and the subtrees under
  // `data-intervu-redact` regardless of configuration.
  redactSnapshot(copy, fullRedact);
  return copy.outerHTML;
};

/** Whether this page's snapshots carry masked content at all. */
const snapshotIsRedacted = (): boolean =>
  fullRedact || document.querySelector(`[${redactAttribute}]`) !== null;

/** An annotation with its captured page text masked, structure untouched. */
const maskAnnotation = (annotation: Annotation): Annotation =>
  annotation.kind === "text"
    ? {
        ...annotation,
        text: maskText(annotation.text),
        selectedText: maskText(annotation.selectedText),
      }
    : { ...annotation, text: maskText(annotation.text) };

/** How much of a failed response's body the panel shows. */
const failureDetailLimit = 160;

/**
 * Why a send failed, as the panel shows it: the HTTP status and the start of
 * the answer - the relay's or daemon's `{error:{message}}`, or the text a proxy
 * answered with, tags stripped.
 */
const failureOf = async (response: Response): Promise<string> => {
  const text = await response.text().catch(() => "");
  let detail = text;
  try {
    const body: unknown = JSON.parse(text);
    if (
      hasField(body, "error") &&
      hasField(body.error, "message") &&
      typeof body.error.message === "string"
    ) {
      detail = body.error.message;
    }
  } catch {
    detail = text.replace(/<[^>]*>/g, " ");
  }
  detail = detail.replace(/\s+/g, " ").trim();
  const status = `HTTP ${response.status}${response.statusText === "" ? "" : ` ${response.statusText}`}`;
  if (detail === "") {
    return status;
  }
  return `${status}: ${detail.length > failureDetailLimit ? `${detail.slice(0, failureDetailLimit - 1)}…` : detail}`;
};

/** How one attempt to post a Feedback went. */
type PostAttempt =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: string };

/** Post one Feedback body to the Session through the relay. */
const postOnce = (key: string, body: string): Promise<PostAttempt> =>
  fetch(relayUrl(`/s/${key}/feedback`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
    .then(
      async (response): Promise<PostAttempt> =>
        response.ok
          ? { ok: true }
          : { ok: false, failure: await failureOf(response) },
    )
    .catch(
      (error: unknown): PostAttempt => ({
        ok: false,
        failure: `network error${error instanceof TypeError && error.message !== "" ? `: ${error.message}` : ""}`,
      }),
    );

/** How a send went, as the panel reports it. */
type SendOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "sentWithoutSnapshot"; readonly failure: string }
  | { readonly kind: "failed"; readonly failure: string };

/** The snapshot an agent gets when the page's own could not be sent. */
const missingSnapshot = (failure: string): string =>
  `<!-- intervu: the page snapshot could not be sent with this Feedback (${failure.replace(/--/g, "- -")}) -->`;

/**
 * Post one Feedback to the Session through the relay. The DOM snapshot makes
 * the body large, and a proxy in front of the dev server may refuse a body
 * that large; then the Feedback goes again with a note in place of the
 * snapshot, so the human's message and annotations still reach the agent.
 */
const postFeedback = async (
  key: string,
  message: string,
  annotations: readonly AppAnnotation[],
): Promise<SendOutcome> => {
  // The human's typed message is never redacted: it carries their intent.
  const body = (domSnapshot: string): string =>
    JSON.stringify({
      message,
      annotations: annotations.map(toWire),
      domSnapshot,
      ...(snapshotIsRedacted() ? { redacted: true } : {}),
    });
  const full = await postOnce(key, body(appSnapshot()));
  if (full.ok) {
    return { kind: "sent" };
  }
  const bare = await postOnce(key, body(missingSnapshot(full.failure)));
  return bare.ok
    ? { kind: "sentWithoutSnapshot", failure: full.failure }
    : { kind: "failed", failure: full.failure };
};

/** A titled section of the panel body. */
const section = (title: string, ...content: HTMLElement[]): HTMLElement => {
  const element = document.createElement("section");
  element.className = "section";
  const heading = document.createElement("h2");
  heading.className = "heading";
  heading.textContent = title;
  element.append(heading, ...content);
  return element;
};

/** One pending-annotation row, built with `textContent` only. */
const pendingRow = (
  { annotation, source }: AppAnnotation,
  onRemove: () => void,
): HTMLLIElement => {
  const row = document.createElement("li");
  row.className = "row";
  row.setAttribute("data-intervu-pending-id", annotation.id);

  const number = document.createElement("span");
  number.className = "number";
  number.setAttribute("data-intervu-pending-number", "");

  const target = document.createElement("div");
  target.className = "target";
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = `<${annotation.tag}>`;
  const detail = document.createElement("span");
  detail.className = "detail";
  detail.textContent =
    annotation.kind === "text"
      ? `"${annotation.selectedText}"`
      : annotation.text;
  target.append(tag, detail);
  if (source !== null) {
    target.title = source;
  }

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove";
  remove.setAttribute("aria-label", "Remove annotation");
  remove.textContent = "×";
  remove.addEventListener("click", onRemove);

  row.append(number, target, remove);
  return row;
};

/** The Send button's resting label. */
const sendLabel = "Send to Agent";

/**
 * The panel's review controls: the pending annotations, the composer with its
 * Annotate toggle, and Send. Returns the body section and the composer footer.
 */
const reviewControls = (
  host: HTMLElement,
  key: string,
): {
  readonly pending: HTMLElement;
  readonly composer: HTMLElement;
  readonly freeze: () => void;
  readonly dispose: () => void;
} => {
  const items = new Map<string, AppAnnotation>();
  let nextId = 0;

  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent =
    "No annotations yet. Turn on Annotate, then point at elements and text in the app.";
  const list = document.createElement("ul");
  list.className = "pending";
  list.setAttribute("data-intervu-pending-list", "");

  const input = document.createElement("textarea");
  input.className = "input";
  input.rows = 3;
  input.placeholder = "Message to the agent...";
  input.setAttribute("aria-label", "Message to the agent");
  input.setAttribute("data-intervu-composer-input", "");
  input.value = readDraft(tabStorage, key);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "button";
  toggle.textContent = "Annotate";
  toggle.setAttribute("aria-pressed", "false");
  toggle.setAttribute("data-intervu-annotate", "");

  const send = document.createElement("button");
  send.type = "button";
  send.className = "button primary";
  send.textContent = sendLabel;
  send.setAttribute("data-intervu-send", "");

  // Why the last send failed, or went without its snapshot; hidden otherwise.
  const sendStatus = document.createElement("p");
  sendStatus.className = "send-status";
  sendStatus.setAttribute("role", "status");
  sendStatus.setAttribute("data-intervu-send-status", "");
  sendStatus.hidden = true;
  const report = (tone: "error" | "warning" | null, text: string): void => {
    sendStatus.hidden = tone === null;
    sendStatus.dataset.tone = tone ?? "";
    sendStatus.textContent = text;
  };

  const sync = (): void => {
    list.hidden = items.size === 0;
    empty.hidden = items.size > 0;
    list
      .querySelectorAll("[data-intervu-pending-number]")
      .forEach((number, index) => {
        number.textContent = String(index + 1);
      });
    send.disabled = input.value.trim().length === 0 && items.size === 0;
  };

  // Drop one pending annotation: its row, its marker and its entry.
  const remove = (id: string): void => {
    items.delete(id);
    list
      .querySelector(`[data-intervu-pending-id="${CSS.escape(id)}"]`)
      ?.remove();
    annotator.overlay.removeMarker(id);
  };

  const annotator = createAnnotator({
    // Events from inside the shadow root reach the app retargeted to the host.
    isOwnNode: (node) => node === host || host.contains(node),
    makeId: () => {
      nextId += 1;
      return `annotation-${nextId}`;
    },
    onAnnotation: (annotation, anchor) => {
      // Captured page text is masked at the capture itself, so unmasked PII
      // never sits in the pending list or leaves the page.
      const item = {
        annotation: redactCapturedText(anchor, fullRedact)
          ? maskAnnotation(annotation)
          : annotation,
        source: sourceOf(anchor),
        pageUrl: window.location.href,
      };
      items.set(annotation.id, item);
      list.append(
        pendingRow(item, () => {
          remove(annotation.id);
          sync();
        }),
      );
      sync();
    },
  });

  annotator.overlay.host.setAttribute(ownMarkupAttribute, "");

  toggle.addEventListener("click", () => {
    const armed = toggle.getAttribute("aria-pressed") !== "true";
    toggle.setAttribute("aria-pressed", String(armed));
    annotator.setMode(armed ? "on" : "off");
  });

  const flash = (label: string): void => {
    send.textContent = label;
    send.disabled = true;
    window.setTimeout(() => {
      send.textContent = sendLabel;
      sync();
    }, 1600);
  };

  send.addEventListener("click", () => {
    const annotations = [...items.values()];
    const message = input.value;
    send.disabled = true;
    send.textContent = "Sending...";
    report(null, "");
    postFeedback(key, message, annotations).then((outcome) => {
      if (outcome.kind === "failed") {
        report("error", `Send failed - ${outcome.failure}`);
        flash("Send failed");
        return;
      }
      if (outcome.kind === "sentWithoutSnapshot") {
        report(
          "warning",
          `Sent without the page snapshot - ${outcome.failure}`,
        );
      }
      // Only what was sent goes: an annotation made or a word typed while the
      // send was in flight stays pending.
      for (const { annotation } of annotations) {
        remove(annotation.id);
      }
      if (input.value === message) {
        input.value = "";
      }
      writeDraft(tabStorage, key, input.value);
      send.textContent = sendLabel;
      sync();
    });
  });
  input.addEventListener("input", () => {
    writeDraft(tabStorage, key, input.value);
    sync();
  });
  sync();

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(toggle, send);

  const composer = document.createElement("div");
  composer.className = "composer";
  composer.id = "intervu-panel-composer";
  composer.setAttribute("data-intervu-composer", "");
  composer.append(input, actions, sendStatus);

  // The Session ended: no more annotations or sends, and the app takes its
  // clicks back.
  const freeze = (): void => {
    annotator.setMode("off");
    toggle.setAttribute("aria-pressed", "false");
    toggle.disabled = true;
    send.disabled = true;
  };

  return {
    pending: section("Pending annotations", empty, list),
    composer,
    freeze,
    dispose: annotator.dispose,
  };
};

/**
 * The Conversation: one bubble per entry, the human's on the right and the
 * agent's on the left, keyed by `seq` so the replay a reconnect sends never
 * doubles a bubble. Text goes in with `textContent` only, so a message can never
 * inject markup into the app's page.
 */
const conversationView = (
  scroller: HTMLElement,
): {
  readonly bubbles: HTMLElement;
  readonly empty: HTMLElement;
  readonly append: (entry: ConversationEntry) => void;
} => {
  const seen = new Set<number>();
  const bubbles = document.createElement("div");
  bubbles.className = "bubbles";
  bubbles.setAttribute("data-intervu-conversation", "");

  const empty = document.createElement("p");
  empty.className = "empty";
  empty.setAttribute("data-intervu-conversation-empty", "");
  empty.textContent =
    "No messages yet. Your feedback and the agent's replies will appear here.";

  const append = (entry: ConversationEntry): void => {
    if (seen.has(entry.seq)) {
      return;
    }
    seen.add(entry.seq);

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.setAttribute("data-role", entry.role);
    bubble.setAttribute("data-intervu-seq", String(entry.seq));

    const role = document.createElement("span");
    role.className = "role";
    role.textContent = roleLabel[entry.role];

    const said = document.createElement("p");
    said.className = "said";
    const { text, countOnly } = bubbleText(entry);
    said.toggleAttribute("data-count-only", countOnly);
    said.textContent = text;

    bubble.append(role, said);
    bubbles.append(bubble);
    empty.hidden = true;
    scroller.scrollTop = scroller.scrollHeight;
  };

  return { bubbles, empty, append };
};

/** The floating panel shown while a Session is open for the origin. */
const renderPanel = (
  host: HTMLElement,
  root: HTMLElement,
  key: string,
): void => {
  root.replaceChildren();

  const panel = document.createElement("section");
  panel.className = "panel";
  panel.setAttribute("data-intervu-panel", "");
  panel.setAttribute("aria-label", "intervu review");

  const header = document.createElement("header");
  header.className = "header";
  header.setAttribute("data-intervu-panel-handle", "");

  const brand = document.createElement("span");
  brand.className = "brand";
  brand.textContent = "intervu";

  const origin = document.createElement("span");
  origin.className = "origin";
  origin.textContent = window.location.host;
  origin.title = window.location.origin;

  const presence = document.createElement("span");
  presence.className = "presence";
  presence.title = "agent presence";
  presence.setAttribute("data-intervu-presence", "");
  const presenceDot = document.createElement("span");
  presenceDot.className = "dot";
  presenceDot.setAttribute("aria-hidden", "true");
  const presenceLabel = document.createElement("span");
  presenceLabel.setAttribute("data-intervu-presence-label", "");
  presence.append(presenceDot, presenceLabel);
  const setPresence = (state: Presence): void => {
    presenceDot.setAttribute("data-presence", state);
    presenceLabel.textContent = state;
  };
  setPresence("idle");

  const endedPill = document.createElement("span");
  endedPill.className = "ended-pill";
  endedPill.hidden = true;
  endedPill.setAttribute("data-intervu-ended-pill", "");
  endedPill.textContent = "Ended";

  const body = document.createElement("div");
  body.className = "body";
  body.id = "intervu-panel-body";
  body.setAttribute("data-intervu-panel-body", "");

  const { pending, composer, freeze, dispose } = reviewControls(host, key);

  const endedNote = document.createElement("p");
  endedNote.className = "ended-note";
  endedNote.id = "intervu-panel-ended-note";
  endedNote.hidden = true;
  endedNote.setAttribute("data-intervu-ended-note", "");
  endedNote.textContent = "This review has ended.";

  const collapse = document.createElement("button");
  collapse.type = "button";
  collapse.className = "collapse";
  collapse.setAttribute("data-intervu-collapse", "");
  collapse.setAttribute(
    "aria-controls",
    `${body.id} ${composer.id} ${endedNote.id}`,
  );
  collapse.append(chevron());

  let ended = false;
  const setExpanded = (expanded: boolean): void => {
    body.hidden = !expanded;
    composer.hidden = !expanded || ended;
    endedNote.hidden = !expanded || !ended;
    panel.toggleAttribute("data-collapsed", !expanded);
    collapse.setAttribute("aria-expanded", String(expanded));
    collapse.setAttribute(
      "aria-label",
      expanded ? "Collapse panel" : "Expand panel",
    );
  };
  collapse.addEventListener("click", () => setExpanded(body.hidden));
  setExpanded(true);

  header.append(brand, origin, presence, endedPill, collapse);

  const conversation = conversationView(body);
  body.append(
    section("Conversation", conversation.empty, conversation.bubbles),
    pending,
  );
  panel.append(header, body, composer, endedNote);
  root.append(panel);
  // The panel's window listeners live until a resumed Session replaces it.
  const lifetime = new AbortController();
  makeDraggable(host, panel, header, lifetime.signal);

  // The Session's SSE stream, through the relay. Vite's HMR reloads the app,
  // so the daemon sends it no artifact version.
  followLiveFrames(relayUrl(`/s/${key}/events`), {
    setPresence,
    appendConversation: conversation.append,
    reload: () => {},
    ended: () => {
      ended = true;
      presence.hidden = true;
      endedPill.hidden = false;
      freeze();
      setExpanded(!body.hidden);
      // `intervu <url>` resumes an ended Session: once it is open again, this
      // tab swaps in a fresh, live panel, as it did from the dormant badge.
      watchForSession((next) => {
        lifetime.abort();
        dispose();
        renderPanel(host, root, next);
      });
    },
  });
};

/**
 * Mount the overlay's shadow host at the end of `<body>`, raise it into the top
 * layer, show the dormant badge and swap in the panel once a Session opens.
 */
const mountOverlay = (): void => {
  const host = document.createElement("intervu-overlay");
  host.popover = "manual";
  host.setAttribute(ownMarkupAttribute, "");
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = STYLES;

  const root = document.createElement("div");
  root.className = "root";

  shadow.append(style, root);
  document.body.append(host);
  host.showPopover();

  const updateBadge = renderDormantBadge(root);
  watchForSession((key) => renderPanel(host, root, key), updateBadge);
};

mountOverlay();
