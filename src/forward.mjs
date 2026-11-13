// A channel's voice on its way to a match: each speaker's Opus frames batched five at a time
// (100 ms) and posted in order. A match that is gone, a refused key or an expired invite stops it
// (what waits is dropped); anything else (no stream yet, the site restarting) is waited out.

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
    /** Told when it stops by itself: the match gone, the key or invite refused. */
    this.onStop = o.onStop ?? (() => {});
    this.onAnswer = o.onAnswer ?? (() => {});
    /** Whether it takes no more frames. */
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
      while (this.waiting.length) await this.#post();
    } finally {
      this.draining = false;
    }
  }

  async #post() {
    const b = this.waiting.shift();
    if (!b) return;
    this.inFlight = true;
    try {
      await this.#answered(await this.fetch(this.url, this.#request(b)), b.frames.length);
    } catch (e) {
      this.onAnswer(`post failed: ${/** @type {Error} */ (e).message}`);
    } finally {
      this.inFlight = false;
    }
  }

  /** @param {{ speaker: Speaker; frames: string[] }} b */
  #request(b) {
    const { steamid, id, name } = b.speaker;
    return {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(POST_MS),
      redirect: /** @type {const} */ ("error"),
      body: JSON.stringify({
        invite: this.invite,
        steamid,
        discord: id,
        name,
        channel: this.channel,
        frames: b.frames,
        delay: this.delay,
      }),
    };
  }

  /** What stv.tf answered a post of `frames`: gone, refused, or how it went. @param {Response} r @param {number} frames */
  async #answered(r, frames) {
    if (r.status === 404) return this.#refused("match ended");
    if (r.status === 401) return this.#refused("key refused");
    if (r.status === 403) return this.#refused("invite expired");
    if (r.ok) this.sent += frames;
    this.onAnswer(`${r.status} ${await r.text()}`);
  }

  /** Takes no more frames; what is batched still goes. Resolves once it is all posted. */
  stop() {
    this.stopped = true;
    return this.flush();
  }

  /** Stopped by stv.tf: what waits is dropped. @param {string} why */
  #refused(why) {
    this.stopped = true;
    this.waiting = [];
    this.batches.clear();
    this.onStop(why);
  }
}
