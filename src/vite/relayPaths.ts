/**
 * The same-origin relay's paths, shared by the `intervu/vite` plugin that
 * mounts them on the dev server and the in-page overlay that calls them. This
 * module imports nothing, so the overlay's browser bundle can take it in.
 */

/** The URL prefix the plugin mounts the relay under on the dev server. */
export const relayPrefix = "/__intervu";

/** The relay path that serves the overlay script. */
export const overlayPath = "/overlay.js";

/** The relay path the overlay asks whether a Session is open for its origin. */
export const sessionPath = "/session";
