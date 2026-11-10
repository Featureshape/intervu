import type { Annotation } from "./protocol.ts";

/**
 * The id-less wire shape of an annotation, as `POST /s/:key/feedback` takes it
 * (the `Protocol.ts` mirror): queue order is identity, so the browser-minted
 * `id` stays behind. Shared by the artifact chrome and URL mode's overlay.
 */
export const annotationToWire = (annotation: Annotation) =>
  annotation.kind === "text"
    ? {
        kind: "text",
        selector: annotation.selector,
        tag: annotation.tag,
        text: annotation.text,
        selectedText: annotation.selectedText,
      }
    : {
        kind: "element",
        selector: annotation.selector,
        tag: annotation.tag,
        text: annotation.text,
      };
