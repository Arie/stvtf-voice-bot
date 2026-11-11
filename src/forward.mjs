// A channel's voice on its way to a match: each speaker's Opus frames batched five at a time
// (100 ms) and posted in order. A match that is gone or a refused key stops it; anything else
// (no stream yet, the site restarting) is waited out.

/** @typedef {{ steamid: string | null; discord: string; name: string }} Speaker */

// Frames in a post, and the most waiting to be posted (10 s of one speaker) before the oldest go.
const BATCH = 5,
  MAX_WAITING = 100;

export class Forwarder {
  /**
   * @param {{ url: string; key: string; delay: number; fetch?: typeof fetch; onStop?: (why: string) => void; onSaid?: (said: string) => void }} o
   */
  constructor(o) {
    this.url = o.url;
    this.key = o.key;
    /** How far the match's stream is behind the game where this channel talks, in seconds. */
    this.delay = o.delay;
    this.fetch = o.fetch ?? fetch;
    this.onStop = o.onStop ?? (() => {});
    this.onSaid = o.onSaid ?? (() => {});
    this.stopped = false;
    this.sent = 0;
    /** @type {Map<string, { speaker: Speaker; frames: string[] }>} */
    this.batches = new Map();
    /** @type {{ speaker: Speaker; frames: string[] }[]} */
    this.waiting = [];
    /** @type {Promise<void>} */
    this.posting = Promise.resolve();
  }

  /** @param {Speaker} speaker @param {Buffer} opus */
  frame(speaker, opus) {
    if (this.stopped) return;
    let b = this.batches.get(speaker.discord);
    if (!b) this.batches.set(speaker.discord, (b = { speaker, frames: [] }));
    b.speaker = speaker;
    b.frames.push(opus.toString("base64"));
    if (b.frames.length >= BATCH) this.#queue(speaker.discord);
  }

  /** What is batched goes now (a timer calls this every 100 ms); resolves once it is all posted. */
  flush() {
    for (const id of [...this.batches.keys()]) this.#queue(id);
    return this.posting;
  }

  /** @param {string} id */
  #queue(id) {
    const b = this.batches.get(id);
    this.batches.delete(id);
    if (!b?.frames.length) return;
    this.waiting.push(b);
    while (this.waiting.length > MAX_WAITING) this.waiting.shift();
    this.posting = this.posting.then(() => this.#post());
  }

  async #post() {
    const b = this.waiting.shift();
    if (!b || this.stopped) return;
    const { steamid, discord, name } = b.speaker;
    try {
      const r = await this.fetch(this.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ steamid, discord, name, frames: b.frames, delay: this.delay }),
      });
      if (r.status === 404) return this.#stop("That match is no longer being watched.");
      if (r.status === 401) return this.#stop("stv.tf refused the bot's key.");
      if (r.ok) this.sent += b.frames.length;
      this.onSaid(`${r.status} ${await r.text()}`);
    } catch (e) {
      this.onSaid(`post failed: ${/** @type {Error} */ (e).message}`);
    }
  }

  /** @param {string} why */
  #stop(why) {
    this.stopped = true;
    this.waiting = [];
    this.batches.clear();
    this.onStop(why);
  }
}
