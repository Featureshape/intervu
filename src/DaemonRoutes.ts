/**
 * The daemon routes the `intervu/vite` plugin's relay reaches, shared by the
 * daemon that serves them and the relay that calls them so the two cannot
 * drift apart. Dependency-free, because the plugin is published as plain ESM
 * that Vite runs on Node.
 */

/** The lookup route that answers which `app` Session is open for an origin. */
export const appSessionPath = "/apps/session";

/** The `GET /apps/session` URL that asks about `origin`. */
export const appSessionUrl = (origin: string): string =>
  `${appSessionPath}?${new URLSearchParams({ origin })}`;

/** How many hex digits of the handle's SHA-256 a Session key keeps. */
export const sessionKeyLength = 16;

/** A Session key, as a regular-expression source for matching route paths. */
export const sessionKeyPattern = `[0-9a-f]{${sessionKeyLength}}`;
