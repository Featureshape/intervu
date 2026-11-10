import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import * as Output from "../src/Output.ts";
import { Feedback } from "../src/Protocol.ts";

describe("Output.home", () => {
  it("shapes the home view in canonical key order", () => {
    const view = Output.home({
      help: "do the thing",
      sessions: [],
      bin: "intervu",
      description: "desc",
    });

    expect(Object.keys(view)).toEqual([
      "bin",
      "description",
      "sessions",
      "help",
    ]);
    expect(view).toEqual({
      bin: "intervu",
      description: "desc",
      sessions: [],
      help: "do the thing",
    });
  });

  it("pins each session row to {key, path, status} order", () => {
    const view = Output.home({
      bin: "intervu",
      description: "desc",
      sessions: [{ status: "open", path: "/tmp/a.html", key: "abc" }],
      help: "next",
    });

    const row = view.sessions[0];
    expect(Object.keys(row ?? {})).toEqual(["key", "path", "status"]);
    expect(row).toEqual({ key: "abc", path: "/tmp/a.html", status: "open" });
  });
});

describe("Output.session", () => {
  it("shapes the session view in canonical key order", () => {
    const view = Output.session({
      help: "next",
      status: "open",
      path: "/tmp/a.html",
      key: "abc",
    });

    expect(Object.keys(view)).toEqual(["key", "path", "status", "help"]);
    expect(view).toEqual({
      key: "abc",
      path: "/tmp/a.html",
      status: "open",
      help: "next",
    });
  });
});

describe("Output.appSession", () => {
  it("shapes the URL-mode session view in canonical key order", () => {
    const view = Output.appSession({
      help: "next",
      status: "open",
      origin: "http://localhost:5173",
      key: "abc",
    });

    expect(Object.keys(view)).toEqual(["key", "origin", "status", "help"]);
    expect(view).toEqual({
      key: "abc",
      origin: "http://localhost:5173",
      status: "open",
      help: "next",
    });
  });
});

describe("Output.error", () => {
  it("shapes a structured error view", () => {
    const view = Output.error({
      tag: "NotFound",
      message: "missing",
      help: "retry",
    });

    expect(view).toEqual({
      error: { tag: "NotFound", message: "missing" },
      help: "retry",
    });
  });
});

describe("Output.pollFeedback", () => {
  it("numbers annotations and keeps selectedText only on the text kind", () => {
    const feedback = new Feedback({
      message: "tighten these",
      annotations: [
        { kind: "element", selector: "#card", tag: "div", text: "Card body" },
        {
          kind: "text",
          selector: "#card h3",
          tag: "h3",
          text: "Heading",
          selectedText: "Head",
        },
      ],
      domSnapshot: "<html><body>snap</body></html>",
    });

    const view = Output.pollFeedback({
      feedback: [
        { feedback, snapshotPath: Option.some("/state/snapshots/a/b.html") },
      ],
      help: "next step",
    });

    expect(Object.keys(view)).toEqual(["feedback", "help"]);
    const item = view.feedback[0];
    expect(item?.message).toBe("tighten these");
    // The snapshot's path is the last key, and the page itself is not included.
    expect(Object.keys(item ?? {})).toEqual([
      "message",
      "annotations",
      "domSnapshotPath",
    ]);
    expect(item?.annotations[0]).toEqual({
      n: 1,
      kind: "element",
      selector: "#card",
      tag: "div",
      text: "Card body",
    });
    expect(item?.annotations[1]).toEqual({
      n: 2,
      kind: "text",
      selector: "#card h3",
      tag: "h3",
      text: "Heading",
      selectedText: "Head",
    });
    // The element annotation carries no selectedText key at all.
    expect(item?.annotations[0] && "selectedText" in item.annotations[0]).toBe(
      false,
    );
    expect(item).toMatchObject({
      domSnapshotPath: "/state/snapshots/a/b.html",
    });
  });

  it("keeps a live app annotation's source and pageUrl after its context", () => {
    const feedback = new Feedback({
      message: "fix the label",
      annotations: [
        {
          kind: "element",
          selector: "#counter",
          tag: "button",
          text: "Clicked 0 times",
          source: "/app/src/App.tsx:29:7",
          pageUrl: "http://localhost:5173/settings?tab=profile",
        },
        {
          kind: "text",
          selector: "#widget",
          tag: "span",
          text: "Third-party widget",
          selectedText: "widget",
          pageUrl: "http://localhost:5173/",
        },
      ],
      domSnapshot: "<html></html>",
    });

    const view = Output.pollFeedback({
      feedback: [{ feedback, snapshotPath: Option.some("/s/a.html") }],
      help: "next step",
    });

    const [element, text] = view.feedback[0]?.annotations ?? [];
    expect(Object.keys(element ?? {})).toEqual([
      "n",
      "kind",
      "selector",
      "tag",
      "text",
      "source",
      "pageUrl",
    ]);
    expect(element).toMatchObject({
      source: "/app/src/App.tsx:29:7",
      pageUrl: "http://localhost:5173/settings?tab=profile",
    });
    // No app code above the target: the key is omitted, not empty.
    expect(Object.keys(text ?? {})).toEqual([
      "n",
      "kind",
      "selector",
      "tag",
      "text",
      "selectedText",
      "pageUrl",
    ]);
  });

  it("delivers the snapshot inline when it could not be saved", () => {
    const view = Output.pollFeedback({
      feedback: [
        {
          feedback: new Feedback({
            message: "keep this",
            annotations: [],
            domSnapshot: "<html>inline</html>",
          }),
          snapshotPath: Option.none(),
        },
      ],
      help: "next",
    });

    expect(view.feedback[0]).toEqual({
      message: "keep this",
      annotations: [],
      domSnapshot: "<html>inline</html>",
    });
  });

  it("renders a drained collection in order", () => {
    const view = Output.pollFeedback({
      feedback: [
        {
          feedback: new Feedback({
            message: "first",
            annotations: [],
            domSnapshot: "a",
          }),
          snapshotPath: Option.some("/a.html"),
        },
        {
          feedback: new Feedback({
            message: "second",
            annotations: [],
            domSnapshot: "b",
          }),
          snapshotPath: Option.some("/b.html"),
        },
      ],
      help: "next",
    });

    expect(view.feedback.map((item) => item.message)).toEqual([
      "first",
      "second",
    ]);
  });
});

describe("Output.pollTimedOut", () => {
  it("shapes the distinct expiry view", () => {
    const view = Output.pollTimedOut({ help: "keep listening" });

    expect(view).toEqual({ timedOut: true, help: "keep listening" });
    expect(Object.keys(view)).toEqual(["timedOut", "help"]);
  });
});

describe("Output.pollEnded", () => {
  it("shapes a plain end (no final feedback) in canonical order", () => {
    const view = Output.pollEnded({ feedback: [], help: "stop polling" });

    expect(view).toEqual({ ended: true, feedback: [], help: "stop polling" });
    expect(Object.keys(view)).toEqual(["ended", "feedback", "help"]);
  });

  it("carries the final feedback of a Send & end", () => {
    const view = Output.pollEnded({
      feedback: [
        {
          feedback: new Feedback({
            message: "last word",
            annotations: [],
            domSnapshot: "x",
          }),
          snapshotPath: Option.some("/x.html"),
        },
      ],
      help: "stop",
    });

    expect(view.ended).toBe(true);
    expect(view.feedback.map((item) => item.message)).toEqual(["last word"]);
  });
});

describe("Output.ended", () => {
  it("shapes the terminal end confirmation", () => {
    const view = Output.ended({ help: "re-run to reopen" });

    expect(view).toEqual({ ended: true, help: "re-run to reopen" });
    expect(Object.keys(view)).toEqual(["ended", "help"]);
  });
});

describe("Output.setup", () => {
  it("shapes both halves in canonical key order", () => {
    const view = Output.setup({
      help: "wired up",
      hook: { action: "installed", path: "/h/.claude/settings.json" },
      skill: { action: "already-present", path: "/h/.claude/skills/x" },
    });

    expect(Object.keys(view)).toEqual(["skill", "hook", "help"]);
    expect(view).toEqual({
      skill: { action: "already-present", path: "/h/.claude/skills/x" },
      hook: { action: "installed", path: "/h/.claude/settings.json" },
      help: "wired up",
    });
  });

  it("omits the Hook when only the Skill was in scope", () => {
    const view = Output.setup({
      skill: { action: "installed", path: "/h/.claude/skills/x" },
      help: "skill only",
    });

    expect(Object.keys(view)).toEqual(["skill", "help"]);
    expect("hook" in view).toBe(false);
  });

  it("omits the Skill when only the Hook was in scope", () => {
    const view = Output.setup({
      hook: { action: "installed", path: "/h/.claude/settings.json" },
      help: "hooks only",
    });

    expect(Object.keys(view)).toEqual(["hook", "help"]);
    expect("skill" in view).toBe(false);
  });
});

describe("Output.merge", () => {
  it("combines fragments with extra winning on conflict", () => {
    const merged = Output.merge(
      { bin: "intervu", help: "old" },
      { help: "new" },
    );

    expect(merged).toEqual({ bin: "intervu", help: "new" });
  });
});
