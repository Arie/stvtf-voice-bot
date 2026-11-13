// What fetch answers and nobody reads: let go of, so its connection is free again.

/** @param {Response} r */
export async function discard(r) {
  await r.body?.cancel().catch(() => {});
}
