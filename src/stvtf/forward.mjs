// Sends a channel's voice to a match: each speaker's Opus frames are batched five at a time
// (100 ms) and posted in order. A match that is gone, a refused key or an expired invite stops it
// (what waits is dropped). A post that gets no answer, or is answered with 409 (no stream yet) or
// a server error (the site is down or restarting), is retried every second until it is accepted.
// Each post says how long it waited, so stv.tf can place it at the tick when it was said. A post
// that waited longer than the delay (and at least 5 s) is dropped. A post refused for another
// reason (too many speakers, malformed) is dropped.
import { discard } from "../http.mjs";
import { REFUSED } from "./status.mjs";

// `id` identifies the speaker in the channel: a Discord user id, or a Mumble id. It is sent as
// `discord`.
/** @typedef {{ steamid: string | null; id: string; name: string }} Speaker */

// A speaker's frames waiting to be posted, since `at` (ms). The last of them came at `until`.
/** @typedef {{ speaker: Speaker; frames: string[]; at: number; until: number }} Waiting */

// BATCH: frames in a post normally. MAX_POST: the most frames in a post when posts are slow;
// a speaker's waiting frames then go as one post, as long as no silence in it is longer than
// TOGETHER_MS. MAX_WAITING: the most posts waiting before the oldest are dropped. POST_MS: how
// long a post may take.
const BATCH = 5,
  MAX_POST = 30,
  TOGETHER_MS = 200,
  MAX_WAITING = 100,
  POST_MS = 3000;
// How long a failed post waits before it is retried; and how long a post is kept at least,
// even with a shorter delay (commentary has a delay of 0).
const RETRY_MS = 1000,
  MIN_KEPT_MS = 5000;

export class Forwarder {
  /**
   * @param {{ url: string; key: string; delay: number; channel?: string; invite?: string; fetch?: typeof fetch; onStop?: (why: string) => void; onAnswer?: (answer: string) => void; now?: () => number; wait?: (ms: number) => Promise<void> }} o
   */
  constructor(o) {
    this.url = o.url;
    this.key = o.key;
    /** How many seconds the match's stream is behind the game this channel talks in. */
    this.delay = o.delay;
    /** The voice channel these speakers are in (Discord's id, or a Mumble `channelOf`): stv.tf takes those in one as a team. */
    this.channel = o.channel;
    /** The match's invite, from the link. */
    this.invite = o.invite;
    this.fetch = o.fetch ?? fetch;
    /** Called when stv.tf stops it: the match is gone, or the key or invite is refused. */
    this.onStop = o.onStop ?? (() => {});
    this.onAnswer = o.onAnswer ?? (() => {});
    /** The clock (ms), and a wait on it. */
    this.now = o.now ?? Date.now;
    this.wait = o.wait ?? (ms => new Promise(r => setTimeout(r, ms)));
    /** Whether it takes no more frames. */
    this.stopped = false;
    /** Whether a post is in flight. Frames that come meanwhile wait, merged into one post per speaker. */
    this.inFlight = false;
    this.sent = 0;
    /** @type {Map<string, { speaker: Speaker; frames: string[] }>} */
    this.batches = new Map();
    /** @type {Waiting[]} */
    this.waiting = [];
    /** Whether a loop is posting what waits. */
    this.draining = false;
    /** @type {Promise<void>} The posting loop's promise: resolves once nothing waits. */
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

  /** Queues what is batched now (a timer calls this every 100 ms). Resolves once it is all posted. */
  flush() {
    for (const id of [...this.batches.keys()]) this.#queue(id);
    return this.posting;
  }

  /** @param {string} id */
  #queue(id) {
    const b = this.batches.get(id);
    this.batches.delete(id);
    if (!b?.frames.length) return;
    // While a post is in flight, these frames are added to this speaker's last waiting post, which
    // keeps them in order.
    const now = this.now();
    const last = this.waiting.findLast(w => w.speaker.id === id);
    const room = last && now - last.until <= TOGETHER_MS && last.frames.length + b.frames.length <= MAX_POST;
    if (this.inFlight && last && room) {
      last.frames.push(...b.frames);
      last.until = now;
      return;
    }
    this.waiting.push({ ...b, at: now, until: now });
    while (this.waiting.length > MAX_WAITING) this.waiting.shift();
    if (this.draining) return;
    this.draining = true;
    // The loop starts after everything queued in this turn, so the batches of one flush are queued
    // as they are and not merged into each other.
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
    const late = this.now() - b.at;
    // Too late: its moment on the stream has passed.
    if (late > Math.max(this.delay * 1000, MIN_KEPT_MS)) return;
    this.inFlight = true;
    try {
      if (await this.#taken(b, late / 1000)) return;
      // Once stopped there are no retries: this post is dropped, and the rest with it.
      if (this.stopped) return void (this.waiting = []);
      this.waiting.unshift(b);
      while (this.waiting.length > MAX_WAITING) this.waiting.shift();
      await this.wait(RETRY_MS);
    } finally {
      this.inFlight = false;
    }
  }

  /** Posts `b`, said `late` seconds ago. Returns whether the post is done with (false: retry it). @param {Waiting} b @param {number} late */
  async #taken(b, late) {
    try {
      return await this.#answered(await this.fetch(this.url, this.#request(b, late)), b.frames.length);
    } catch (e) {
      this.onAnswer(`post failed: ${/** @type {Error} */ (e).message}`);
      return false;
    }
  }

  /** @param {Waiting} b @param {number} late */
  #request(b, late) {
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
        late,
      }),
    };
  }

  /**
   * Handles what stv.tf answered to a post of `frames` frames. Returns whether the post is done
   * with: it is not when there is no stream yet (409) or the site has a server error.
   * @param {Response} r @param {number} frames
   */
  async #answered(r, frames) {
    const refused = REFUSED[r.status];
    if (refused) {
      await discard(r);
      this.#refused(refused);
      return true;
    }
    if (r.ok) this.sent += frames;
    this.onAnswer(`${r.status} ${await r.text()}`);
    return r.status !== 409 && r.status < 500;
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
