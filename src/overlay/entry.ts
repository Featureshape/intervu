import { createAnnotator } from "../sdk/annotator.ts";
import { annotationToWire } from "../sdk/feedbackWire.ts";
import type { Annotation } from "../sdk/protocol.ts";
import { sourceAttribute } from "../vite/jsxSource.ts";
import {
  ownMarkupAttribute,
  relayPrefix,
  sessionPath,
} from "../vite/relayPaths.ts";
import { openSessionKeyIn } from "../vite/sessionAnswer.ts";

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
  .live { background: #22c55e; }
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

/** The relay route the overlay asks whether a Session is open for its origin. */
const sessionLookupPath = `${relayPrefix}${sessionPath}`;

/** How often the dormant badge asks whether a Session has opened. */
const sessionLookupIntervalMs = 1_000;

/** The command that opens a URL-mode Session for this page's origin. */
const openCommand = (): string => `intervu ${window.location.origin}`;

/**
 * Ask the relay which Session is open for this origin. A dev server that
 * stopped answering is "not yet": the next ask tries again.
 */
const lookupOpenSession = async (): Promise<string | null> => {
  try {
    const response = await fetch(sessionLookupPath, { cache: "no-store" });
    return response.ok ? openSessionKeyIn(await response.json()) : null;
  } catch {
    return null;
  }
};

/**
 * Ask once a second until a Session is open, then call `onOpen` once with its
 * key.
 */
const watchForSession = (onOpen: (key: string) => void): void => {
  const ask = (): void => {
    lookupOpenSession().then((key) => {
      if (key !== null) {
        onOpen(key);
      } else {
        window.setTimeout(ask, sessionLookupIntervalMs);
      }
    });
  };
  ask();
};

/** The dormant badge and the card its click reveals. */
const renderDormantBadge = (root: HTMLElement): void => {
  root.replaceChildren();

  const card = document.createElement("div");
  card.className = "card";
  card.id = "intervu-dormant-card";
  card.hidden = true;
  card.setAttribute("data-intervu-dormant-card", "");

  const title = document.createElement("p");
  title.className = "title";
  title.textContent = "No agent is reviewing this app";

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "Ask your agent to run:";

  const command = document.createElement("code");
  command.className = "command";
  command.setAttribute("data-intervu-command", "");
  command.textContent = openCommand();

  card.append(title, hint, command);

  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = "badge";
  badge.setAttribute("data-intervu-badge", "dormant");
  badge.setAttribute("aria-expanded", "false");
  badge.setAttribute("aria-controls", card.id);

  const dot = document.createElement("span");
  dot.className = "dot";
  dot.setAttribute("aria-hidden", "true");
  badge.append(dot, "intervu: no agent");

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
 */
const makeDraggable = (
  host: HTMLElement,
  panel: HTMLElement,
  handle: HTMLElement,
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
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  });

  window.addEventListener("resize", () => {
    if (placed) {
      const box = host.getBoundingClientRect();
      placeAt(box.left, box.top);
    }
  });
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

/** The JSX source of the nearest element above `anchor` the app's code wrote. */
const sourceOf = (anchor: Element): string | null =>
  anchor.closest(`[${sourceAttribute}]`)?.getAttribute(sourceAttribute) ?? null;

/** An annotation's wire shape, with the live app's source and page. */
const toWire = ({ annotation, source, pageUrl }: AppAnnotation) => ({
  ...annotationToWire(annotation),
  ...(source === null ? {} : { source }),
  pageUrl,
});

/**
 * The app's DOM as the human sees it, without intervu: the overlay's host, the
 * annotation markers' host and the plugin's overlay script are dropped from a
 * copy, so the snapshot the agent reads is the app's own markup.
 */
const appSnapshot = (): string => {
  const copy = document.importNode(document.documentElement, true);
  for (const own of copy.querySelectorAll(`[${ownMarkupAttribute}]`)) {
    own.remove();
  }
  return copy.outerHTML;
};

/** Post one Feedback to the Session through the relay; whether it queued. */
const postFeedback = (
  key: string,
  message: string,
  annotations: readonly AppAnnotation[],
): Promise<boolean> =>
  fetch(`${relayPrefix}/s/${key}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message,
      annotations: annotations.map(toWire),
      domSnapshot: appSnapshot(),
    }),
  })
    .then((response) => response.ok)
    .catch(() => false);

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
): { readonly pending: HTMLElement; readonly composer: HTMLElement } => {
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
      const item = {
        annotation,
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
    postFeedback(key, message, annotations).then((queued) => {
      if (!queued) {
        flash("Send failed");
        return;
      }
      // Only what was sent goes: an annotation made or a word typed while the
      // send was in flight stays pending.
      for (const { annotation } of annotations) {
        remove(annotation.id);
      }
      if (input.value === message) {
        input.value = "";
      }
      send.textContent = sendLabel;
      sync();
    });
  });
  input.addEventListener("input", sync);
  sync();

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(toggle, send);

  const composer = document.createElement("div");
  composer.className = "composer";
  composer.id = "intervu-panel-composer";
  composer.setAttribute("data-intervu-composer", "");
  composer.append(input, actions);

  return {
    pending: section("Pending annotations", empty, list),
    composer,
  };
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

  const dot = document.createElement("span");
  dot.className = "dot live";
  dot.setAttribute("aria-hidden", "true");

  const brand = document.createElement("span");
  brand.className = "brand";
  brand.textContent = "intervu";

  const origin = document.createElement("span");
  origin.className = "origin";
  origin.textContent = window.location.host;
  origin.title = window.location.origin;

  const body = document.createElement("div");
  body.className = "body";
  body.id = "intervu-panel-body";
  body.setAttribute("data-intervu-panel-body", "");

  const { pending, composer } = reviewControls(host, key);

  const collapse = document.createElement("button");
  collapse.type = "button";
  collapse.className = "collapse";
  collapse.setAttribute("data-intervu-collapse", "");
  collapse.setAttribute("aria-controls", `${body.id} ${composer.id}`);
  collapse.append(chevron());

  const setExpanded = (expanded: boolean): void => {
    body.hidden = !expanded;
    composer.hidden = !expanded;
    panel.toggleAttribute("data-collapsed", !expanded);
    collapse.setAttribute("aria-expanded", String(expanded));
    collapse.setAttribute(
      "aria-label",
      expanded ? "Collapse panel" : "Expand panel",
    );
  };
  collapse.addEventListener("click", () => setExpanded(body.hidden));
  setExpanded(true);

  header.append(dot, brand, origin, collapse);

  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent =
    "No messages yet. Your feedback and the agent's replies will appear here.";

  body.append(section("Conversation", empty), pending);
  panel.append(header, body, composer);
  root.append(panel);
  makeDraggable(host, panel, header);
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

  renderDormantBadge(root);
  watchForSession((key) => renderPanel(host, root, key));
};

mountOverlay();
