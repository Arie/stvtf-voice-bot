// Cancels the body of a fetch response that nobody reads, so its connection is free again.

/** @param {Response} r */
export async function discard(r) {
  await r.body?.cancel().catch(() => {});
}
