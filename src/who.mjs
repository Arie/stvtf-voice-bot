// Who a Discord user is on Steam, as stv.tf knows from their link (GET /voice/who): kept once
// known, asked again in a while for those not linked (they may link meanwhile).

const ASK_AGAIN_MS = 60_000,
  ASK_MS = 3000;

export class Who {
  /** @param {{ url: string; key: string; fetch?: typeof fetch; now?: () => number }} o */
  constructor(o) {
    this.o = { fetch, now: Date.now, ...o };
    /** @type {Map<string, { steamid: string | null; at: number }>} */
    this.known = new Map();
    /** @type {Map<string, Promise<string | null>>} */
    this.asking = new Map();
  }

  /** @param {string} discord A Discord user id. @returns {Promise<string | null>} `[U:1:N]`, or null. */
  steamid(discord) {
    const k = this.known.get(discord);
    if (k && (k.steamid || this.o.now() - k.at < ASK_AGAIN_MS)) return Promise.resolve(k.steamid);
    // One question at a time about someone: every frame of theirs asks.
    let asking = this.asking.get(discord);
    if (!asking) {
      asking = this.#ask(discord).finally(() => this.asking.delete(discord));
      this.asking.set(discord, asking);
    }
    return asking;
  }

  /** @param {string} discord */
  async #ask(discord) {
    let steamid = null;
    try {
      const r = await this.o.fetch(`${this.o.url}?discord=${encodeURIComponent(discord)}`, {
        headers: { Authorization: `Bearer ${this.o.key}` },
        signal: AbortSignal.timeout(ASK_MS),
        redirect: "error",
      });
      if (r.ok) steamid = (await r.json()).steamid ?? null;
    } catch {}
    this.known.set(discord, { steamid, at: this.o.now() });
    return steamid;
  }

  /** What is known of `discord` now, without asking. */
  peek(discord) {
    return this.known.get(discord)?.steamid ?? null;
  }
}
