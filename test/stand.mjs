// A made-up stand-in, taken as the real thing it stands for (what the code is given decides which).

/** @template T @param {unknown} fake @returns {T} */
export const stand = fake => /** @type {T} */ (fake);

/** What a made-up fetch is given. @typedef {{ method?: string; headers: Record<string, string>; body: string; signal?: AbortSignal }} Init */

/** A fetch that answers as `f` does. @param {(url: string, init: Init) => unknown} f @returns {typeof fetch} */
export const fetchOf = f => stand(f);

/** A turn of the event loop. */
export const tick = () => new Promise(r => setImmediate(r));

/** Waits a turn at a time until `f()` holds, as long as it takes but no longer than `turns`. @param {() => unknown} f */
export async function until(f, turns = 1000) {
  for (let n = 0; n < turns; n++) {
    if (f()) return;
    await tick();
  }
  throw new Error(`not after ${turns} turns: ${f}`);
}

/** A body nobody reads, that says whether it was let go of. */
export function unread() {
  const body = { cancelled: false, cancel: async () => void (body.cancelled = true) };
  return body;
}
