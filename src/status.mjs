// stv.tf told how it goes in a channel the bot is in for a match, and who is in it (so they can
// be put on players before they speak), or that the bot left: `POST <page>voice-status`.

import { discard } from "./http.mjs";

const POST_MS = 3000;

/** What an answer's status says is the end of it. @type {Record<number, string | undefined>} */
export const REFUSED = { 404: "match ended", 401: "key refused", 403: "invite expired" };

/**
 * Where the bot is in a channel, for the page to go by (`status` is only for showing): in it,
 * could not get in, or out again. The status says which channel and how many are there, why it
 * could not join, or why it left.
 */
export const STATE = /** @type {const} */ ({ in: "in", failed: "failed", left: "left" });
/** @typedef {(typeof STATE)[keyof typeof STATE]} State */

/**
 * @param {{ page: string; key: string; invite: string | null; fetch?: typeof fetch }} target
 * @param {{ kind: "discord" | "mumble"; state: State; status?: string; people?: { id: string; name: string }[]; left?: boolean; asked?: number; job?: number; channel?: string }} body
 * @returns {Promise<string | undefined>} Why stv.tf will have none of it, if so: the match is gone,
 *   the key refused or the invite expired, as a voice post is told.
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
    // Not answering now: it is told again soon.
  }
}
