import type { Locator, Page } from "@playwright/test";

/**
 * The URL-mode overlay's controls, located by their data hooks. Playwright's
 * locators pierce the overlay's shadow root, so each reads from the page.
 */

/** The floating panel an open Session shows. */
export const panel = (page: Page): Locator =>
  page.locator("[data-intervu-panel]");

/** The panel's header, the grip it is dragged by. */
export const handle = (page: Page): Locator =>
  page.locator("[data-intervu-panel-handle]");

/** The badge the overlay shows while no Session is open. */
export const badge = (page: Page): Locator =>
  page.locator("[data-intervu-badge]");

/** The button that collapses the panel to its header and expands it again. */
export const collapse = (page: Page): Locator =>
  page.locator("[data-intervu-collapse]");

/** The panel's Annotate-mode toggle. */
export const annotate = (page: Page): Locator =>
  page.locator("[data-intervu-annotate]");

/** The rows of the annotations pending in the composer. */
export const pendingRows = (page: Page): Locator =>
  page.locator("[data-intervu-pending-id]");

/** The composer's message field. */
export const composerInput = (page: Page): Locator =>
  page.locator("[data-intervu-composer-input]");

/** The composer's Send button. */
export const sendButton = (page: Page): Locator =>
  page.locator("[data-intervu-send]");

/** The label of the agent's Presence. */
export const presenceLabel = (page: Page): Locator =>
  page.locator("[data-intervu-presence-label]");

/** The bubble of `role` in the panel's Conversation that reads `text`. */
export const bubble = (
  page: Page,
  role: "human" | "agent",
  text: string,
): Locator =>
  page
    .locator(`[data-intervu-conversation] .bubble[data-role="${role}"]`)
    .filter({ hasText: text });
