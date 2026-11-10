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
 * DOM overlay; capture-phase suppressors keep the document from acting on the
 * same gesture, its press as well as its click. With the mode off nothing is intercepted. Gestures on a
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
  /** Remove the capture listeners and the marker overlay, for good. */
  readonly dispose: () => void;
}

/** The pointer events the loop listens for on `window`, in the capture phase. */
type CapturedEvent =
  | "click"
  | "pointerdown"
  | "mousedown"
  | "pointerup"
  | "mouseup"
  | "mouseover";

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

  // Whether a primary-button press event belongs to an armed gesture.
  const isArmedPress = (event: MouseEvent): boolean =>
    capturing && event.button === 0 && !isIgnored(event.target);

  // The press of the gesture is kept from the document too, so a menu that
  // opens on `pointerdown` or a drag that starts on `mousedown` stays put. No
  // `preventDefault`: the browser still extends a drag-selection natively.
  const onPress = (event: MouseEvent): void => {
    if (isArmedPress(event)) {
      event.stopImmediatePropagation();
    }
  };

  // The annotation is built on mouseup, where the selection is finalized: a
  // non-collapsed selection is a text annotation, otherwise the click target is
  // an element annotation.
  const onMouseUp = (event: MouseEvent): void => {
    if (!isArmedPress(event)) {
      return;
    }
    event.stopImmediatePropagation();
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

  const listeners: readonly (readonly [
    CapturedEvent,
    (event: MouseEvent) => void,
  ])[] = [
    ["click", onClick],
    ["pointerdown", onPress],
    ["mousedown", onPress],
    ["pointerup", onPress],
    ["mouseup", onMouseUp],
    ["mouseover", onPointerMove],
  ];
  for (const [type, listener] of listeners) {
    window.addEventListener(type, listener, true);
  }

  const setMode = (mode: AnnotateMode): void => {
    capturing = mode === "on";
    document.documentElement.style.cursor = capturing ? "crosshair" : "";
    if (!capturing) {
      overlay.previewTarget(null);
    }
  };

  const dispose = (): void => {
    setMode("off");
    for (const [type, listener] of listeners) {
      window.removeEventListener(type, listener, true);
    }
    overlay.destroy();
  };

  return { overlay, setMode, dispose };
};
