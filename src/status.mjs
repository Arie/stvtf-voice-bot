// stv.tf told how it goes in a channel the bot is in for a match, and who is in it (so they can
// be put on players before they speak), or that the bot left: `POST <page>voice-status`.

const TELL_MS = 3000;

/**
 * @param {{ page: string; key: string; invite: string | null; fetch?: typeof fetch }} to
 * @param {{ kind: "discord" | "mumble"; status?: string; people?: { id: string; name: string }[]; left?: boolean; asked?: number; channel?: string }} what
 */
export async function tell(to, what) {
  try {
    await (to.fetch ?? fetch)(`${to.page}voice-status`, {
      method: "POST",
      headers: { Authorization: `Bearer ${to.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ invite: to.invite, ...what }),
      signal: AbortSignal.timeout(TELL_MS),
      redirect: "error",
    });
  } catch {
    // Not answering now: it is told again soon.
  }
}
