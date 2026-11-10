/**
 * Where the daemon listens, shared by the CLI's `AppConfig` and the
 * `intervu/vite` plugin so both look for it on the same port. Dependency-free,
 * because the plugin is published as plain ESM that Vite runs on Node.
 */

/** Default loopback port; `INTERVU_PORT` overrides. */
export const defaultDaemonPort = 51789;

/** The range a valid `INTERVU_PORT` falls in. */
export const portRange = { minimum: 1, maximum: 65535 } as const;

/**
 * The port an `INTERVU_PORT` value names, or the default when it is unset or
 * not an integer in range - the same fallback `AppConfig` applies.
 */
export const daemonPortFrom = (raw: string | undefined): number => {
  const port =
    raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isInteger(port) &&
    port >= portRange.minimum &&
    port <= portRange.maximum
    ? port
    : defaultDaemonPort;
};
