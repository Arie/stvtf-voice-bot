// How the bot ends, on SIGINT or SIGTERM: it calls `stop` once, waits `ms` at most for it,
// then exits.

/**
 * @param {{
 *   stop: () => Promise<unknown>; ms: number; on?: (signal: string, f: () => void) => void;
 *   exit?: (code: number) => void; deadline?: (ms: number) => Promise<void>;
 * }} o `on`, `exit` and `deadline` are for tests.
 */
export function stopOnSignal({
  stop,
  ms,
  on = (signal, f) => process.once(signal, f),
  exit = code => process.exit(code),
  deadline = n => new Promise(r => setTimeout(r, n)),
}) {
  let stopping = false;
  const end = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.race([stop().catch(() => {}), deadline(ms)]);
    exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"]) on(signal, end);
}
