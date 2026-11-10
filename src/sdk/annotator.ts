import {
  buildElementAnnotation,
  buildTextAnnotation,
  type IdSource,
  resolveElementAnchor,
  resolveSelectionAnchor,
} from "./capture.ts";
import { createOverlay, type MarkerOverlay } from "./overlay.ts";
import type { AnnotateMode, Annotation } from "./protocol.ts";
import { cssSelectorFor } from "./selector.ts";

/**
 * Annotate-mode's capture loop (CONTEXT.md "Annotate-mode"; ADR 0006), shared
 * by the in-iframe SDK and URL mode's in-page overlay. With the mode on it takes
 * the crosshair cursor, previews the element under the pointer, and turns clicks
 * and drag-selections into selector-based annotations, each marked in a Shadow
 * DOM overlay; a capture-phase click suppressor keeps the document from acting
 * on the same gesture. With the mode off nothing is intercepted. Gestures on a
 * node the caller owns (its own UI) are never captured or suppressed.
 */

/** What the caller supplies: its own nodes, ids, and where annotations go. */
export interface AnnotatorOptions {
  /** Whether `node` belongs to the caller's own UI, never an annotation target. */
  readonly isOwnNode: (node: Node) => boolean;
  /** Mints each annotation's id. */
  readonly makeId: IdSource;
  /** Called once per captured annotation, after its marker is drawn. */
  readonly onAnnotation: (annotation: Annotation, anchor: Element) => void;
}

/** The handle the caller drives the loop with. */
export interface Annotator {
  /** The marker overlay, for removing an annotation's marker. */
  readonly overlay: MarkerOverlay;
  /** Turn capture on or off. */
  readonly setMode: (mode: AnnotateMode) => void;
}

/** Install the capture listeners on `window`, with the mode off. */
export const createAnnotator = (options: AnnotatorOptions): Annotator => {
  const overlay = createOverlay();
  let capturing = false;

  const isIgnored = (node: unknown): boolean =>
    node instanceof Node &&
    (node === overlay.host ||
      overlay.host.contains(node) ||
      options.isOwnNode(node));

  const emit = (annotation: Annotation, anchor: Element): void => {
    overlay.addMarker(annotation.id, anchor);
    options.onAnnotation(annotation, anchor);
  };

  const captureText = (selection: Selection): boolean => {
    if (selection.rangeCount === 0 || selection.isCollapsed) {
      return false;
    }
    const anchor = resolveSelectionAnchor(selection.getRangeAt(0));
    if (anchor === null || isIgnored(anchor)) {
      return false;
    }
    const annotation = buildTextAnnotation(
      anchor,
      selection.toString(),
      cssSelectorFor,
      options.makeId,
    );
    emit(annotation, anchor);
    selection.removeAllRanges();
    return true;
  };

  const captureElement = (target: EventTarget | null): void => {
    const anchor = resolveElementAnchor(target);
    if (anchor === null || isIgnored(anchor)) {
      return;
    }
    emit(
      buildElementAnnotation(anchor, cssSelectorFor, options.makeId),
      anchor,
    );
  };

  // Capture-phase, on `window` so it runs ahead of the document's handlers:
  // stop the gesture from driving it (navigation, submits, framework clicks).
  const onClick = (event: MouseEvent): void => {
    if (!capturing || isIgnored(event.target)) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  // The annotation is built on mouseup, where the selection is finalized: a
  // non-collapsed selection is a text annotation, otherwise the click target is
  // an element annotation.
  const onMouseUp = (event: MouseEvent): void => {
    if (!capturing || event.button !== 0 || isIgnored(event.target)) {
      return;
    }
    const selection = window.getSelection();
    if (selection !== null && captureText(selection)) {
      return;
    }
    captureElement(event.target);
  };

  const onPointerMove = (event: MouseEvent): void => {
    if (!capturing) {
      return;
    }
    const target = event.target;
    overlay.previewTarget(
      target instanceof Element && !isIgnored(target) ? target : null,
    );
  };

  window.addEventListener("click", onClick, true);
  window.addEventListener("mouseup", onMouseUp, true);
  window.addEventListener("mouseover", onPointerMove, true);

  const setMode = (mode: AnnotateMode): void => {
    capturing = mode === "on";
    document.documentElement.style.cursor = capturing ? "crosshair" : "";
    if (!capturing) {
      overlay.previewTarget(null);
    }
  };

  return { overlay, setMode };
};
