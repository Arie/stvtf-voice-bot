// stv.tf told how it goes in a channel the bot is in for a match, and who is in it (so they can
// be put on players before they speak), or that the bot left: `POST <page>voice-status`.

import { discard } from "./http.mjs";

const POST_MS = 3000;

/**
 * @param {{ page: string; key: string; invite: string | null; fetch?: typeof fetch }} target
 * @param {{ kind: "discord" | "mumble"; status?: string; people?: { id: string; name: string }[]; left?: boolean; asked?: number; job?: number; channel?: string }} body
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
  } catch {
    // Not answering now: it is told again soon.
  }
}
