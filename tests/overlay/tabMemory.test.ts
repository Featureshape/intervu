import { describe, expect, it } from "@effect/vitest";
import {
  readDraft,
  readPosition,
  type TabStorage,
  writeDraft,
  writePosition,
} from "../../src/overlay/tabMemory.ts";

/**
 * What the in-page panel keeps across a full page reload: the unsent message
 * per Session and the panel's position. A garbled entry reads as none, and a
 * browser that refuses storage leaves the panel working without the memory.
 */

/** An in-memory stand-in for the tab's `sessionStorage`. */
const memoryStorage = (): TabStorage & {
  readonly size: () => number;
} => {
  const entries = new Map<string, string>();
  return {
    size: () => entries.size,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
};

/** A storage whose every call throws, as a browser that refuses storage does. */
const refusingStorage: TabStorage = {
  getItem: () => {
    throw new DOMException("storage refused", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("quota exceeded", "QuotaExceededError");
  },
  removeItem: () => {
    throw new DOMException("storage refused", "SecurityError");
  },
};

describe("drafts", () => {
  it("keeps the unsent message per Session", () => {
    const storage = memoryStorage();
    writeDraft(storage, "aaaa", "fix the header");
    writeDraft(storage, "bbbb", "another origin");
    expect(readDraft(storage, "aaaa")).toBe("fix the header");
    expect(readDraft(storage, "bbbb")).toBe("another origin");
    expect(readDraft(storage, "cccc")).toBe("");
  });

  it("drops the entry once the message is empty", () => {
    const storage = memoryStorage();
    writeDraft(storage, "aaaa", "fix the header");
    writeDraft(storage, "aaaa", "");
    expect(storage.size()).toBe(0);
    expect(readDraft(storage, "aaaa")).toBe("");
  });

  it("reads none and never throws when storage is refused", () => {
    expect(() => writeDraft(refusingStorage, "aaaa", "text")).not.toThrow();
    expect(() => writeDraft(refusingStorage, "aaaa", "")).not.toThrow();
    expect(readDraft(refusingStorage, "aaaa")).toBe("");
  });
});

describe("panel position", () => {
  it("round-trips the position", () => {
    const storage = memoryStorage();
    writePosition(storage, { left: 120.5, top: 48 });
    expect(readPosition(storage)).toEqual({ left: 120.5, top: 48 });
  });

  it("reads a missing, malformed, mistyped or non-finite entry as none", () => {
    const storage = memoryStorage();
    expect(readPosition(storage)).toBeNull();
    // Store each garbled entry the way a stale or foreign writer would.
    for (const stored of [
      "not json",
      "null",
      "[1,2]",
      '{"left":10}',
      '{"left":"10","top":20}',
      '{"left":10,"top":null}',
      '{"left":1e999,"top":0}',
      '{"left":0,"top":-1e999}',
    ]) {
      storage.setItem("intervu:panel-position", stored);
      expect(readPosition(storage), stored).toBeNull();
    }
  });

  it("reads none and never throws when storage is refused", () => {
    expect(() =>
      writePosition(refusingStorage, { left: 1, top: 2 }),
    ).not.toThrow();
    expect(readPosition(refusingStorage)).toBeNull();
  });
});
