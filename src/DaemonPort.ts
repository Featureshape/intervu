/**
 * Where the daemon listens, shared by the CLI's `AppConfig` and the
 * `intervu/vite` plugin so both look for it on the same port. Dependency-free,
 * because the plugin is published as plain ESM that Vite runs on Node.
 */

/** Default loopback port; `INTERVU_PORT` overrides. */
export const defaultDaemonPort = 51789;

/**
 * The fixed range daemons from different agent sandboxes coexist on: a new
 * daemon binds the first free port in it, and the plugin probes all of it.
 * An explicit `INTERVU_PORT` pins everything to exactly that port instead.
 */
export const daemonPortRange = { start: 51789, end: 51798 } as const;

/** Every port of the fixed coexistence range, in bind order. */
export const rangePorts: readonly number[] = Array.from(
  { length: daemonPortRange.end - daemonPortRange.start + 1 },
  (_, index) => daemonPortRange.start + index,
);

/** The range a valid `INTERVU_PORT` falls in. */
const portRange = { minimum: 1, maximum: 65535 } as const;

/** Whether `raw` names a valid explicit port. */
const pinnedPortOf = (raw: string | undefined): number | null => {
  const port =
    raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isInteger(port) &&
    port >= portRange.minimum &&
    port <= portRange.maximum
    ? port
    : null;
};

/**
 * The ports the CLI and the plugin look for daemons on: exactly the pinned
 * port when `INTERVU_PORT` names one (no range scan), else the whole fixed
 * range.
 */
export const daemonPortsFrom = (raw: string | undefined): readonly number[] => {
  const pinned = pinnedPortOf(raw);
  return pinned === null ? rangePorts : [pinned];
};

/**
 * The port an `INTERVU_PORT` value names, or the default when it is unset or
 * not an integer in range. `AppConfig` and the plugin both read it through
 * here, so the CLI and the plugin always agree on the port.
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
