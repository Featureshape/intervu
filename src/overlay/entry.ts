import { relayPrefix, sessionPath } from "../vite/relayPaths.ts";

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
`;

/** The relay route the overlay asks whether a Session is open for its origin. */
const sessionLookupPath = `${relayPrefix}${sessionPath}`;

/** How often the dormant badge asks whether a Session has opened. */
const sessionLookupIntervalMs = 1_000;

/** The command that opens a URL-mode Session for this page's origin. */
const openCommand = (): string => `intervu ${window.location.origin}`;

/** Whether `value` is an object carrying `name`, narrowing it for reading. */
const hasField = <K extends string>(
  value: unknown,
  name: K,
): value is Record<K, unknown> =>
  typeof value === "object" && value !== null && name in value;

/** Whether the relay's lookup answer names an open Session. */
const isOpenSession = (answer: unknown): boolean =>
  hasField(answer, "session") &&
  hasField(answer.session, "status") &&
  answer.session.status === "open";

/**
 * Ask the relay whether a Session is open for this origin. A dev server that
 * stopped answering is "not yet": the next ask tries again.
 */
const sessionIsOpen = async (): Promise<boolean> => {
  try {
    const response = await fetch(sessionLookupPath, { cache: "no-store" });
    return response.ok && isOpenSession(await response.json());
  } catch {
    return false;
  }
};

/** Ask once a second until a Session is open, then call `onOpen` once. */
const watchForSession = (onOpen: () => void): void => {
  const ask = (): void => {
    sessionIsOpen().then((open) => {
      if (open) {
        onOpen();
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

/** The floating panel shown while a Session is open for the origin. */
const renderPanel = (host: HTMLElement, root: HTMLElement): void => {
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

  const collapse = document.createElement("button");
  collapse.type = "button";
  collapse.className = "collapse";
  collapse.setAttribute("data-intervu-collapse", "");
  collapse.setAttribute("aria-controls", body.id);
  collapse.append(chevron());

  const setExpanded = (expanded: boolean): void => {
    body.hidden = !expanded;
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

  const heading = document.createElement("h2");
  heading.className = "heading";
  heading.textContent = "Conversation";

  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent =
    "No messages yet. Your feedback and the agent's replies will appear here.";

  body.append(heading, empty);
  panel.append(header, body);
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
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = STYLES;

  const root = document.createElement("div");
  root.className = "root";

  shadow.append(style, root);
  document.body.append(host);
  host.showPopover();

  renderDormantBadge(root);
  watchForSession(() => renderPanel(host, root));
};

mountOverlay();
