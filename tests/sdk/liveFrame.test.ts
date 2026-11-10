import { describe, expect, it } from "@effect/vitest";
import { bubbleText, parseLiveFrame } from "../../src/sdk/liveFrame.ts";

/**
 * The browser's gate on the daemon's SSE frames, shared by the artifact chrome
 * and URL mode's panel: a frame reaches the page only when every field it reads
 * has the right type, and an annotation-only Feedback reads as its count.
 */

describe("parseLiveFrame", () => {
  it("reads each frame the daemon sends", () => {
    expect(
      parseLiveFrame('{"_tag":"PresenceChanged","presence":"listening"}'),
    ).toEqual({ _tag: "PresenceChanged", presence: "listening" });
    expect(
      parseLiveFrame(
        '{"_tag":"ConversationAppended","seq":3,"role":"agent","text":"on it","annotationCount":0}',
      ),
    ).toEqual({
      _tag: "ConversationAppended",
      seq: 3,
      role: "agent",
      text: "on it",
      annotationCount: 0,
    });
    expect(
      parseLiveFrame('{"_tag":"ArtifactReloaded","version":"12-34"}'),
    ).toEqual({ _tag: "ArtifactReloaded", version: "12-34" });
    expect(parseLiveFrame('{"_tag":"SessionEnded"}')).toEqual({
      _tag: "SessionEnded",
    });
  });

  it("keeps only the fields a page reads", () => {
    expect(
      parseLiveFrame(
        '{"_tag":"ConversationAppended","seq":1,"role":"human","text":"hi","annotationCount":2,"html":"<b>"}',
      ),
    ).toEqual({
      _tag: "ConversationAppended",
      seq: 1,
      role: "human",
      text: "hi",
      annotationCount: 2,
    });
  });

  it("is null for data that is not JSON or not an object", () => {
    expect(parseLiveFrame("not json")).toBeNull();
    expect(parseLiveFrame("null")).toBeNull();
    expect(parseLiveFrame('"SessionEnded"')).toBeNull();
    expect(parseLiveFrame("{}")).toBeNull();
  });

  it("is null for an unknown tag or a field of the wrong type", () => {
    expect(parseLiveFrame('{"_tag":"FeedbackQueued"}')).toBeNull();
    expect(
      parseLiveFrame('{"_tag":"PresenceChanged","presence":"away"}'),
    ).toBeNull();
    expect(
      parseLiveFrame(
        '{"_tag":"ConversationAppended","seq":"1","role":"agent","text":"x","annotationCount":0}',
      ),
    ).toBeNull();
    expect(
      parseLiveFrame(
        '{"_tag":"ConversationAppended","seq":1,"role":"system","text":"x","annotationCount":0}',
      ),
    ).toBeNull();
    expect(
      parseLiveFrame('{"_tag":"ArtifactReloaded","version":7}'),
    ).toBeNull();
  });
});

describe("bubbleText", () => {
  const entry = { seq: 1, role: "human", annotationCount: 0 } as const;

  it("reads as the message when there is one", () => {
    expect(bubbleText({ ...entry, text: "tighten it" })).toEqual({
      text: "tighten it",
      countOnly: false,
    });
  });

  it("reads an annotation-only Feedback as its count", () => {
    expect(bubbleText({ ...entry, text: "  ", annotationCount: 1 })).toEqual({
      text: "1 annotation",
      countOnly: true,
    });
    expect(bubbleText({ ...entry, text: "", annotationCount: 3 })).toEqual({
      text: "3 annotations",
      countOnly: true,
    });
  });

  it("keeps a blank message with no annotations as it is", () => {
    expect(bubbleText({ ...entry, text: "" })).toEqual({
      text: "",
      countOnly: false,
    });
  });
});
