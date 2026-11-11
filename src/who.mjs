// Who a Discord user is on Steam, as stv.tf knows from their link (GET /voice/who): kept once
// known, asked again in a while for those not linked (they may link meanwhile).

const ASK_AGAIN_MS = 60_000;

export class Who {
  /** @param {{ url: string; key: string; fetch?: typeof fetch; now?: () => number }} o */
  constructor(o) {
    this.o = { fetch, now: Date.now, ...o };
    /** @type {Map<string, { steamid: string | null; at: number }>} */
    this.known = new Map();
  }

  /** @param {string} discord A Discord user id. @returns {Promise<string | null>} `[U:1:N]`, or null. */
  async steamid(discord) {
    const k = this.known.get(discord);
    const now = this.o.now();
    if (k && (k.steamid || now - k.at < ASK_AGAIN_MS)) return k.steamid;
    let steamid = null;
    try {
      const r = await this.o.fetch(`${this.o.url}?discord=${encodeURIComponent(discord)}`, {
        headers: { Authorization: `Bearer ${this.o.key}` },
      });
      if (r.ok) steamid = (await r.json()).steamid ?? null;
    } catch {}
    this.known.set(discord, { steamid, at: now });
    return steamid;
  }

  /** What is known of `discord` now, without asking. */
  peek(discord) {
    return this.known.get(discord)?.steamid ?? null;
  }
}
