/**
 * Bound a startup/reachability probe in time, not just in success. A black-holed
 * endpoint (TCP accepts, the TLS handshake never completes) settles *never*, so a bare
 * await blocks the caller forever — the whole server boot hangs on one flaky
 * dependency. Race the probe against a deadline and let the caller treat "timed out"
 * like any other probe failure.
 *
 * The losing promise is guarded: a rejection that arrives after the deadline already
 * fired is swallowed there rather than surfacing later as an unhandled rejection.
 */
export function withDeadline<T>(probe: Promise<T>, ms: number, label: string): Promise<T> {
  probe.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([probe, deadline]).finally(() => clearTimeout(timer));
}
