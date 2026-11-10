/**
 * The in-page overlay for URL mode: the `intervu/vite` plugin injects this
 * script into the running app's own document. Everything it renders lives in
 * one shadow root, so the app's CSS cannot reach it and its CSS cannot leak into
 * the app (the same encapsulation as the artifact marker overlay, ADR 0005).
 *
 * With no Session open for the origin the overlay rests as the dormant badge:
 * a small "intervu: no agent" pill whose click reveals the command to hand the
 * agent. It makes no network request in this state, so a stopped daemon leaves
 * the app's console clean.
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
`;

/** The command that opens a URL-mode Session for this page's origin. */
const openCommand = (): string => `intervu ${window.location.origin}`;

/** Mount the dormant badge in its own shadow root at the end of `<body>`. */
const mountDormantBadge = (): void => {
  const host = document.createElement("intervu-overlay");
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = STYLES;

  const root = document.createElement("div");
  root.className = "root";

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
  shadow.addEventListener("keydown", (event) => {
    if (event instanceof KeyboardEvent && event.key === "Escape") {
      setOpen(false);
    }
  });

  root.append(card, badge);
  shadow.append(style, root);
  document.body.append(host);
};

mountDormantBadge();
