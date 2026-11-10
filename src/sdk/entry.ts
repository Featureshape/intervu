import { createAnnotator } from "./annotator.ts";
import { onMessageFromParent, postToParent } from "./bridge.ts";
import type { AnnotateMode } from "./protocol.ts";

/**
 * The in-iframe SDK (CONTEXT.md "Bridge"; ADR 0003 / 0005 / 0006), injected into
 * every artifact at `/sdk.js`. It runs Annotate-mode's capture loop
 * (`annotator.ts`) and posts each annotation up to the chrome over the Bridge;
 * the chrome sets the mode, removes markers, and asks for the DOM snapshot over
 * the same Bridge. With the mode off nothing is intercepted and the artifact is
 * fully itself; stacked markers persist until the chrome removes them.
 */

const MODE_ATTRIBUTE = "data-intervu-mode";

const main = (): void => {
  const annotator = createAnnotator({
    isOwnNode: () => false,
    makeId: () => crypto.randomUUID(),
    onAnnotation: (annotation) =>
      postToParent({ kind: "annotation-added", annotation }),
  });

  const applyMode = (mode: AnnotateMode): void => {
    document.documentElement.setAttribute(MODE_ATTRIBUTE, mode);
    annotator.setMode(mode);
  };

  // Report at most one scroll position per frame, so the chrome can restore it
  // across a live-reload (ADR 0020).
  let scrollReportPending = false;
  window.addEventListener("scroll", () => {
    if (scrollReportPending) {
      return;
    }
    scrollReportPending = true;
    requestAnimationFrame(() => {
      scrollReportPending = false;
      postToParent({
        kind: "scroll-changed",
        x: window.scrollX,
        y: window.scrollY,
      });
    });
  });

  applyMode("off");
  onMessageFromParent((message) => {
    if (message.kind === "set-mode") {
      applyMode(message.mode);
    } else if (message.kind === "restore-scroll") {
      window.scrollTo({
        left: message.x,
        top: message.y,
        behavior: "instant",
      });
    } else if (message.kind === "annotation-removed") {
      annotator.overlay.removeMarker(message.id);
    } else if (message.kind === "snapshot-request") {
      // The live, rendered DOM the human annotated (ADR 0008) - the document
      // the annotation selectors resolve against, which diverges from the
      // on-disk source for any interactive artifact.
      postToParent({
        kind: "snapshot-result",
        html: document.documentElement.outerHTML,
      });
    }
  });
};

main();
