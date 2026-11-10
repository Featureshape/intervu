/**
 * What the in-page panel keeps in the tab's `sessionStorage` so a full page
 * reload does not lose the human's work: the unsent message draft, per Session,
 * and where the panel was dragged to. Whether the panel was collapsed is not
 * kept; a reload opens it expanded.
 *
 * Storage is best effort: a browser that refuses it (a privacy mode, a full
 * quota) leaves the panel working, only without the memory.
 */

import { hasField } from "../hasField.ts";

/** The slice of the Web Storage API the panel uses. */
export interface TabStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

/** Where the panel's host sits in the viewport, in CSS pixels. */
export interface PanelPosition {
  readonly left: number;
  readonly top: number;
}

/** The storage key of the Session `key`'s unsent message draft. */
const draftKey = (key: string): string => `intervu:draft:${key}`;

/** The storage key of the panel's position. */
const positionKey = "intervu:panel-position";

/** Read `key` from `storage`, or `null` when it is absent or unreadable. */
const readItem = (storage: TabStorage, key: string): string | null => {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
};

/** Store `value` under `key`, or drop the entry when `value` is `null`. */
const writeItem = (
  storage: TabStorage,
  key: string,
  value: string | null,
): void => {
  try {
    if (value === null) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, value);
    }
  } catch {
    // Storage refused: the draft or position lives only until the next reload.
  }
};

/** The Session `key`'s unsent message draft, or `""` when there is none. */
export const readDraft = (storage: TabStorage, key: string): string =>
  readItem(storage, draftKey(key)) ?? "";

/** Keep `draft` as the Session `key`'s unsent message; an empty one is dropped. */
export const writeDraft = (
  storage: TabStorage,
  key: string,
  draft: string,
): void => writeItem(storage, draftKey(key), draft === "" ? null : draft);

/** `value` as a panel position, or `null` unless it holds two finite numbers. */
const positionIn = (value: unknown): PanelPosition | null =>
  hasField(value, "left") &&
  hasField(value, "top") &&
  typeof value.left === "number" &&
  typeof value.top === "number" &&
  Number.isFinite(value.left) &&
  Number.isFinite(value.top)
    ? { left: value.left, top: value.top }
    : null;

/** The panel's stored position, or `null` when none is stored or it is garbled. */
export const readPosition = (storage: TabStorage): PanelPosition | null => {
  const stored = readItem(storage, positionKey);
  if (stored === null) {
    return null;
  }
  try {
    return positionIn(JSON.parse(stored));
  } catch {
    return null;
  }
};

/** Keep the panel's `position` for the next page load in this tab. */
export const writePosition = (
  storage: TabStorage,
  position: PanelPosition,
): void => writeItem(storage, positionKey, JSON.stringify(position));
