// A channel's voice on its way to a match: each speaker's Opus frames batched five at a time
// (100 ms) and posted in order. A match that is gone, a refused key or an expired invite stops it;
// anything else (no stream yet, the site restarting) is waited out.

// `id` is who they are in the channel: a Discord user id, or a Mumble one; sent as `discord`.
/** @typedef {{ steamid: string | null; id: string; name: string }} Speaker */

// Frames in a post as they come, and at most when posts are slow (what waits of a speaker goes
// as one); the most posts waiting before the oldest go; and how long a post may take.
const BATCH = 5,
  MAX_POST = 30,
  MAX_WAITING = 100,
  POST_MS = 3000;

export class Forwarder {
  /**
   * @param {{ url: string; key: string; delay: number; channel?: string; invite?: string; fetch?: typeof fetch; onStop?: (why: string) => void; onAnswer?: (answer: string) => void }} o
   */
  constructor(o) {
    this.url = o.url;
    this.key = o.key;
    /** How far the match's stream is behind the game where this channel talks, in seconds. */
    this.delay = o.delay;
    /** The Discord voice channel these speakers are in: stv.tf takes those in one for a team. */
    this.channel = o.channel;
    /** The match's invite, from the link. */
    this.invite = o.invite;
    this.fetch = o.fetch ?? fetch;
    this.onStop = o.onStop ?? (() => {});
    this.onAnswer = o.onAnswer ?? (() => {});
    this.stopped = false;
    /** Whether a post is on its way: what comes meanwhile waits, a speaker's as one post. */
    this.inFlight = false;
    this.sent = 0;
    /** @type {Map<string, { speaker: Speaker; frames: string[] }>} */
    this.batches = new Map();
    /** @type {{ speaker: Speaker; frames: string[] }[]} */
    this.waiting = [];
    /** Whether a loop is posting what waits. */
    this.draining = false;
    /** @type {Promise<void>} The loop's, resolved once nothing waits. */
    this.posting = Promise.resolve();
  }

  /** @param {Speaker} speaker @param {Buffer} opus */
  add(speaker, opus) {
    if (this.stopped) return;
    let b = this.batches.get(speaker.id);
    if (!b) this.batches.set(speaker.id, (b = { speaker, frames: [] }));
    b.speaker = speaker;
    b.frames.push(opus.toString("base64"));
    if (b.frames.length >= BATCH) this.#queue(speaker.id);
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
    // Behind a slow post, onto what already waits of this speaker (the last of all, so in order).
    const last = this.waiting.at(-1);
    if (this.inFlight && last && last.speaker.id === id && last.frames.length + b.frames.length <= MAX_POST) {
      last.frames.push(...b.frames);
      return;
    }
    this.waiting.push(b);
    while (this.waiting.length > MAX_WAITING) this.waiting.shift();
    if (this.draining) return;
    this.draining = true;
    // Begun after what is queued now: a flush's batches go as they are, not onto each other.
    this.posting = Promise.resolve().then(() => this.#drain());
  }

  /** One post at a time until nothing waits. */
  async #drain() {
    try {
      while (this.waiting.length && !this.stopped) await this.#post();
    } finally {
      this.draining = false;
    }
  }

  async #post() {
    const b = this.waiting.shift();
    if (!b || this.stopped) return;
    const { steamid, id, name } = b.speaker;
    this.inFlight = true;
    try {
      const r = await this.fetch(this.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(POST_MS),
        redirect: "error",
        body: JSON.stringify({
          invite: this.invite,
          steamid,
          discord: id,
          name,
          channel: this.channel,
          frames: b.frames,
          delay: this.delay,
        }),
      });
      if (r.status === 404) return this.#stop("match ended");
      if (r.status === 401) return this.#stop("key refused");
      if (r.status === 403) return this.#stop("invite expired");
      if (r.ok) this.sent += b.frames.length;
      this.onAnswer(`${r.status} ${await r.text()}`);
    } catch (e) {
      this.onAnswer(`post failed: ${/** @type {Error} */ (e).message}`);
    } finally {
      this.inFlight = false;
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
