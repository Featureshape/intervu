import { Option } from "effect";

/**
 * The running app a URL-mode Session reviews (ADR 0022), as `intervu <url>`
 * takes it: `url` is the page the agent named, which `--open` opens, and
 * `origin` is the Session's handle, so every route of one dev server shares a
 * Session.
 */
export interface AppUrl {
  readonly url: string;
  readonly origin: string;
}

/**
 * Read `raw` as an app URL, or `None` when it is not an absolute `http:` or
 * `https:` URL - which is how a file path such as `report.html` or
 * `localhost:5173` (a URL with the scheme `localhost:`) falls through to
 * artifact mode.
 */
export const parseAppUrl = (raw: string): Option.Option<AppUrl> =>
  Option.fromNullishOr(URL.parse(raw)).pipe(
    Option.filter(
      (parsed) => parsed.protocol === "http:" || parsed.protocol === "https:",
    ),
    Option.map((parsed) => ({ url: parsed.href, origin: parsed.origin })),
  );
