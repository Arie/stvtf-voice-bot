// A made-up stand-in, taken as the real thing it stands for (what the code is given decides which).

/** @template T @param {unknown} fake @returns {T} */
export const stand = fake => /** @type {T} */ (fake);

/** What a made-up fetch is given. @typedef {{ method?: string; headers: Record<string, string>; body: string; signal?: AbortSignal }} Init */

/** A fetch that answers as `f` does. @param {(url: string, init: Init) => unknown} f @returns {typeof fetch} */
export const fetchOf = f => stand(f);
