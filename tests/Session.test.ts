import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { OpenSessionRequest } from "../src/Protocol.ts";
import { Session, SessionKey } from "../src/Session.ts";

/**
 * Sessions persisted, and `POST /sessions` bodies sent, before URL mode carry no
 * `kind`; they must still decode, as the artifact Sessions they are (ADR 0022).
 */
describe("Session kind", () => {
  it.effect("a Session without a kind decodes as an artifact", () =>
    Effect.gen(function* () {
      const session = yield* Schema.decodeUnknownEffect(Session)({
        key: "abc0000000000000",
        path: "/tmp/a.html",
        status: "open",
      });
      expect(session.kind).toBe("artifact");
    }),
  );

  it.effect("an app Session round-trips its kind", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(Session)(
        new Session({
          key: SessionKey.make("abc0000000000000"),
          path: "http://localhost:5173",
          status: "open",
          kind: "app",
        }),
      );
      expect(encoded.kind).toBe("app");
      const decoded = yield* Schema.decodeUnknownEffect(Session)(encoded);
      expect(decoded.kind).toBe("app");
    }),
  );

  it.effect("an open request without a kind opens an artifact", () =>
    Effect.gen(function* () {
      const request = yield* Schema.decodeUnknownEffect(OpenSessionRequest)({
        path: "/tmp/a.html",
      });
      expect(request.kind).toBe("artifact");
    }),
  );
});
