import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { Feedback } from "../src/Protocol.ts";
import { Session, SessionKey } from "../src/Session.ts";
import { SessionPersistence } from "../src/SessionPersistence.ts";
import { SessionStore } from "../src/SessionStore.ts";

const feedbackWith = (message: string): Feedback =>
  new Feedback({ message, annotations: [], domSnapshot: "<html></html>" });

/**
 * SessionStore exercised against the in-memory `SessionPersistence` layer, with
 * real `BunCrypto` for deterministic key derivation. No filesystem is touched.
 */

const storeLayer = (seed: readonly Session[] = []) =>
  SessionStore.layer.pipe(
    Layer.provideMerge(SessionPersistence.memoryLayer(seed)),
    Layer.provide(BunCrypto.layer),
  );

describe("SessionStore", () => {
  it.effect("open returns a Session that get and list reflect", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;

      const session = yield* store.open("/tmp/a.html", "artifact");
      expect(session.path).toBe("/tmp/a.html");
      expect(session.status).toBe("open");

      const all = yield* store.list;
      expect(all).toHaveLength(1);

      const found = yield* store.get(session.key);
      expect(Option.getOrUndefined(found)?.key).toBe(session.key);

      const missing = yield* store.get(SessionKey.make("ffffffffffffffff"));
      expect(Option.isSome(missing)).toBe(false);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("derives a stable 16-char hex key from the path", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;

      const first = yield* store.open("/tmp/a.html", "artifact");
      const again = yield* store.open("/tmp/a.html", "artifact");
      const other = yield* store.open("/tmp/b.html", "artifact");

      expect(first.key).toBe(again.key);
      expect(first.key).not.toBe(other.key);
      expect(first.key).toMatch(/^[0-9a-f]{16}$/);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("re-opening the same path resumes one Session", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;

      const first = yield* store.open("/tmp/a.html", "artifact");
      const second = yield* store.open("/tmp/a.html", "artifact");

      expect(second.key).toBe(first.key);
      const all = yield* store.list;
      expect(all).toHaveLength(1);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("persists opened Sessions through the port", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const session = yield* store.open("/tmp/a.html", "artifact");

      const persistence = yield* SessionPersistence;
      const persisted = yield* persistence.load;

      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.key).toBe(session.key);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect(
    "queueFeedback then takeFeedback drains in order, exactly once",
    () =>
      Effect.gen(function* () {
        const store = yield* SessionStore;
        const session = yield* store.open("/tmp/a.html", "artifact");

        yield* store.queueFeedback(session.key, feedbackWith("first"));
        yield* store.queueFeedback(session.key, feedbackWith("second"));

        const drained = yield* store.takeFeedback(session.key);
        expect(drained.map((feedback) => feedback.message)).toEqual([
          "first",
          "second",
        ]);

        // Take-once: a second take after a drain is the definitive empty state.
        const again = yield* store.takeFeedback(session.key);
        expect(again).toHaveLength(0);
      }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("takeFeedback on a never-queued key is empty, not an error", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const session = yield* store.open("/tmp/a.html", "artifact");

      const drained = yield* store.takeFeedback(session.key);
      expect(drained).toHaveLength(0);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("re-opening a path preserves its queued feedback", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const first = yield* store.open("/tmp/a.html", "artifact");
      yield* store.queueFeedback(first.key, feedbackWith("queued"));

      // The idempotent reopen must not drop the in-flight queue.
      yield* store.open("/tmp/a.html", "artifact");

      const drained = yield* store.takeFeedback(first.key);
      expect(drained.map((feedback) => feedback.message)).toEqual(["queued"]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("end flips open -> ended and persists", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const session = yield* store.open("/tmp/a.html", "artifact");

      yield* store.end(session.key);

      const found = yield* store.get(session.key);
      expect(Option.getOrUndefined(found)?.status).toBe("ended");

      const persistence = yield* SessionPersistence;
      const persisted = yield* persistence.load;
      expect(persisted[0]?.status).toBe("ended");
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("end is idempotent on an already-ended Session", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const session = yield* store.open("/tmp/a.html", "artifact");

      yield* store.end(session.key);
      // A second end is a no-op: still ended, still one Session.
      yield* store.end(session.key);

      const found = yield* store.get(session.key);
      expect(Option.getOrUndefined(found)?.status).toBe("ended");
      const all = yield* store.list;
      expect(all).toHaveLength(1);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("end on an unknown key is a no-op, not an error", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      yield* store.end(SessionKey.make("ffffffffffffffff"));
      const all = yield* store.list;
      expect(all).toHaveLength(0);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("re-opening an ended Session resurrects it to open", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const first = yield* store.open("/tmp/a.html", "artifact");
      yield* store.end(first.key);

      const resurrected = yield* store.open("/tmp/a.html", "artifact");

      // Same key, back to open, no duplicate state (ADR 0012).
      expect(resurrected.key).toBe(first.key);
      expect(resurrected.status).toBe("open");
      const all = yield* store.list;
      expect(all).toHaveLength(1);

      const persistence = yield* SessionPersistence;
      const persisted = yield* persistence.load;
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.status).toBe("open");
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("an app Session is keyed by its origin and keeps its kind", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const app = yield* store.open("http://localhost:5173", "app");
      const again = yield* store.open("http://localhost:5173", "app");
      const artifact = yield* store.open("/tmp/a.html", "artifact");

      expect(app.kind).toBe("app");
      expect(app.path).toBe("http://localhost:5173");
      expect(again.key).toBe(app.key);
      expect(artifact.kind).toBe("artifact");
      expect(artifact.key).not.toBe(app.key);

      const found = yield* store.getByPath("http://localhost:5173");
      expect(Option.getOrUndefined(found)?.key).toBe(app.key);

      const persistence = yield* SessionPersistence;
      const persisted = yield* persistence.load;
      expect(persisted.map((session) => session.kind)).toEqual([
        "app",
        "artifact",
      ]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("ending and resurrecting an app Session keeps its kind", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const app = yield* store.open("http://localhost:5173", "app");
      yield* store.end(app.key);

      const ended = yield* store.get(app.key);
      expect(Option.getOrUndefined(ended)?.kind).toBe("app");

      const resurrected = yield* store.open("http://localhost:5173", "app");
      expect(resurrected.key).toBe(app.key);
      expect(resurrected.status).toBe("open");
      expect(resurrected.kind).toBe("app");
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("end preserves the queued feedback for a resurrect", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const session = yield* store.open("/tmp/a.html", "artifact");
      yield* store.queueFeedback(session.key, feedbackWith("survives"));

      // end touches only status + persistence, never the transient queue (ADR 0002).
      yield* store.end(session.key);
      yield* store.open("/tmp/a.html", "artifact");

      const drained = yield* store.takeFeedback(session.key);
      expect(drained.map((feedback) => feedback.message)).toEqual(["survives"]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("getByPath resolves the same Session as the derived key", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const opened = yield* store.open("/tmp/a.html", "artifact");

      const found = yield* store.getByPath("/tmp/a.html");
      expect(Option.getOrUndefined(found)?.key).toBe(opened.key);

      const missing = yield* store.getByPath("/tmp/never.html");
      expect(Option.isSome(missing)).toBe(false);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("appendConversation stamps a monotonic 1-based seq per key", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const session = yield* store.open("/tmp/a.html", "artifact");

      const first = yield* store.appendConversation(session.key, {
        role: "human",
        text: "tighten this",
        annotationCount: 2,
      });
      const second = yield* store.appendConversation(session.key, {
        role: "agent",
        text: "done",
        annotationCount: 0,
      });

      expect(first.seq).toBe(1);
      expect(first.role).toBe("human");
      expect(first.annotationCount).toBe(2);
      expect(second.seq).toBe(2);
      expect(second.role).toBe("agent");
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect(
    "conversationSince replays only entries newer than the cursor",
    () =>
      Effect.gen(function* () {
        const store = yield* SessionStore;
        const session = yield* store.open("/tmp/a.html", "artifact");

        yield* store.appendConversation(session.key, {
          role: "human",
          text: "one",
          annotationCount: 0,
        });
        yield* store.appendConversation(session.key, {
          role: "agent",
          text: "two",
          annotationCount: 0,
        });

        // A first connect (cursor 0) replays the whole thread; a reconnect at
        // seq 1 replays only what it has not seen.
        const all = yield* store.conversationSince(session.key, 0);
        expect(all.map((entry) => entry.text)).toEqual(["one", "two"]);

        const after = yield* store.conversationSince(session.key, 1);
        expect(after.map((entry) => entry.text)).toEqual(["two"]);

        const none = yield* store.conversationSince(session.key, 2);
        expect(none).toHaveLength(0);
      }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("conversations are keyed per Session", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const a = yield* store.open("/tmp/a.html", "artifact");
      const b = yield* store.open("/tmp/b.html", "artifact");

      yield* store.appendConversation(a.key, {
        role: "human",
        text: "for a",
        annotationCount: 0,
      });

      const onB = yield* store.conversationSince(b.key, 0);
      expect(onB).toHaveLength(0);
      // B's first entry starts its own seq at 1, independent of A.
      const bEntry = yield* store.appendConversation(b.key, {
        role: "human",
        text: "for b",
        annotationCount: 0,
      });
      expect(bEntry.seq).toBe(1);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("a fresh store adopts persisted Sessions on startup", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const all = yield* store.list;

      expect(all).toHaveLength(1);
      expect(all[0]?.path).toBe("/tmp/seed.html");
    }).pipe(
      Effect.provide(
        storeLayer([
          new Session({
            key: SessionKey.make("seedkey000000000"),
            path: "/tmp/seed.html",
            status: "open",
            kind: "artifact",
            lastActivityAt: 1_700_000_000_000,
          }),
        ]),
      ),
    ),
  );
});

describe("SessionStore activity and the TTL sweep", () => {
  it.effect("open stamps lastActivityAt, and touch bumps it", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      yield* TestClock.adjust("1 second");
      const session = yield* store.open("/tmp/a.html", "artifact");
      expect(session.lastActivityAt).toBe(1_000);

      yield* TestClock.adjust("5 seconds");
      yield* store.touch(session.key);
      const touched = yield* store.get(session.key);
      expect(Option.getOrUndefined(touched)?.lastActivityAt).toBe(6_000);

      // Unknown keys are a no-op, not an error.
      yield* store.touch(SessionKey.make("ffffffffffffffff"));
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("re-opening bumps activity, so a resume never expires early", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const first = yield* store.open("/tmp/a.html", "artifact");
      yield* TestClock.adjust("10 seconds");
      const again = yield* store.open("/tmp/a.html", "artifact");
      expect(again.key).toBe(first.key);
      expect(again.lastActivityAt).toBe(10_000);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("the sweep flips only open Sessions idle past the TTL", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const idle = yield* store.open("/tmp/idle.html", "artifact");
      yield* TestClock.adjust("2 hours");
      const fresh = yield* store.open("/tmp/fresh.html", "artifact");

      const flipped = yield* store.sweepExpired(60 * 60 * 1000);
      expect(flipped).toBe(1);
      const after = yield* store.list;
      expect(after.map((session) => [session.path, session.status])).toEqual([
        ["/tmp/idle.html", "ended"],
        ["/tmp/fresh.html", "open"],
      ]);

      // Idempotent: a second sweep finds nothing left to flip, and the
      // swept Session resurrects on re-open as any ended one does.
      expect(yield* store.sweepExpired(60 * 60 * 1000)).toBe(0);
      const revived = yield* store.open("/tmp/idle.html", "artifact");
      expect(revived.status).toBe("open");
      expect(revived.key).toBe(idle.key);
      expect(fresh.status).toBe("open");
    }).pipe(Effect.provide(storeLayer())),
  );
});
