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

/**
 * The warning for an origin no browser will ever report: `http:` with an
 * explicit port 443 (TLS spoken to in plain http) or `https:` with an
 * explicit port 80. A browser on the same address reports the other scheme
 * with no port, so a Session keyed by `app.origin` is one no page can find.
 * The Session still opens; the warning names the origin a browser would
 * actually report. `None` for every other URL.
 */
export const schemePortWarning = (app: AppUrl): Option.Option<string> => {
  const parsed = URL.parse(app.origin);
  if (parsed === null) {
    return Option.none();
  }
  const suggested =
    parsed.protocol === "http:" && parsed.port === "443"
      ? `https://${parsed.hostname}`
      : parsed.protocol === "https:" && parsed.port === "80"
        ? `http://${parsed.hostname}`
        : null;
  return suggested === null
    ? Option.none()
    : Option.some(
        `${app.origin} is an origin no browser will report - a browser on that address reports ${suggested}, so the overlay will not find this Session; if that is the page's address, run 'intervu ${suggested}'`,
      );
};
