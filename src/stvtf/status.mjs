// Tells stv.tf the bot's status in a channel it is in for a match and who is in that channel (so
// the page can match them to players before they speak), or that the bot left:
// `POST <page>voice-status`.

import { discard } from "../http.mjs";

const POST_MS = 3000;

/** The HTTP statuses that mean stv.tf wants no more for this match, and why. @type {Record<number, string | undefined>} */
export const REFUSED = { 404: "match ended", 401: "key refused", 403: "invite expired" };

/**
 * The bot's state in a channel, which the page acts on: in it, could not join, or left again.
 * `status` is text for display only: which channel and how many are there, why it could not
 * join, or why it left.
 */
export const STATE = /** @type {const} */ ({ in: "in", failed: "failed", left: "left" });
/** @typedef {(typeof STATE)[keyof typeof STATE]} State */

/**
 * @param {{ page: string; key: string; invite: string | null; fetch?: typeof fetch }} target
 * @param {{ kind: "discord" | "mumble"; state: State; status?: string; people?: { id: string; name: string }[]; left?: boolean; asked?: number; job?: number; channel?: string }} body
 * @returns {Promise<string | undefined>} Why stv.tf refuses it, if it does: the match is gone,
 *   the key is refused or the invite expired (the same answers a voice post gets).
 */
export async function postStatus(target, body) {
  try {
    const r = await (target.fetch ?? fetch)(`${target.page}voice-status`, {
      method: "POST",
      headers: { Authorization: `Bearer ${target.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ invite: target.invite, ...body }),
      signal: AbortSignal.timeout(POST_MS),
      redirect: "error",
    });
    await discard(r);
    return REFUSED[r.status];
  } catch {
    // No answer now: the status is posted again soon.
  }
}
