// The bot in one Mumble channel for one match: every speaker's voice regrouped into packets of
// 20 ms and passed to stv.tf, each known by who they are on that server (registered, or their
// certificate), so the match's page can put them on a player and keep them there.
import dns from "node:dns/promises";
import { Forwarder } from "../forward.mjs";
import { MumbleClient, voiceId } from "./client.mjs";
import { channelOf, isPublic } from "./jobs.mjs";
import { Twenties } from "./repack.mjs";

// How often what waits is sent, and how often the page is told who is in the channel.
const FLUSH_MS = 100,
  STATUS_MS = 10_000;
// What a name in use is refused as (Mumble's Reject.UsernameInUse), and how many names are tried.
const IN_USE = 5,
  NAMES = 3;
// A server on this machine or its network is joined only when said so (for trying it out).
const ANYWHERE = process.env.STVTF_MUMBLE_ANYWHERE === "1";

/** @typedef {(host: string, o: { all: true }) => Promise<{ address: string }[]>} Lookup */

/**
 * Where to reach `host`: one of its addresses, once every one is known to be out on the internet
 * (a name can give one public and one private, and a second lookup another).
 * @param {string} host @param {{ lookup?: Lookup; anywhere?: boolean }} [o]
 */
export async function addressOf(host, { lookup = dns.lookup, anywhere = ANYWHERE } = {}) {
  const all = await lookup(host, { all: true });
  if (!all.length) throw new Error("no address");
  if (!anywhere && !all.every(a => isPublic(a.address))) throw new Error("private address");
  return all[0].address;
}

/** @typedef {(text: string, people?: { id: string; name: string }[]) => void} Status */
/**
 * @typedef {{ key: string; name?: string; lookup?: Lookup; connect?: () => import("node:stream").Duplex;
 *   fetch?: typeof fetch }} Options `lookup`, `connect` and `fetch` are for tests.
 */

/**
 * @param {import("./jobs.mjs").Job} job @param {Status} status @param {Options} o
 * @returns {import("./jobs.mjs").Session}
 */
export function startSession(job, status, o) {
  return new MumbleSession(job, status, o);
}

class MumbleSession {
  /** @type {MumbleClient | null} */
  client = null;
  /** @type {ReturnType<typeof setInterval>[]} */
  timers = [];
  /** Whether it is done: told to leave, out, or never in. */
  gone = false;
  /** @type {Promise<void> | null} Once told to leave: resolves when the connection is closed. */
  closing = null;
  /** @type {Map<number, Twenties>} By the speaker's session on the server. */
  packers = new Map();
  /** @type {string | undefined} */
  address;

  /** @param {import("./jobs.mjs").Job} job @param {Status} status @param {Options} o */
  constructor(job, status, o) {
    this.job = job;
    this.status = status;
    this.o = o;
    this.forwarder = new Forwarder({
      url: job.voice,
      key: o.key,
      delay: job.delay,
      invite: job.invite,
      fetch: o.fetch,
      channel: channelOf(job),
      onStop: why => this.leave(why),
    });
    this.started = this.#start();
  }

  get delay() {
    return this.forwarder.delay;
  }

  set delay(d) {
    if (d === this.forwarder.delay) return;
    this.forwarder.delay = d;
    this.client?.say(`tv_delay: ${d} s${d ? "" : " (live)"}`);
  }

  /** @param {string} why @returns {Promise<void>} Once its connection is closed. */
  leave(why) {
    if (this.closing) return this.closing;
    this.gone = true;
    this.timers.forEach(clearInterval);
    this.forwarder.flush();
    this.closing = (async () => {
      if (this.client?.in) {
        this.client.say(`Leaving: ${why}`);
        // The goodbye gets a moment to go out.
        await new Promise(r => setTimeout(r, 200));
      }
      this.client?.leave(why);
      // A join under way ends once its connection is closed; one not yet begun is not begun.
      await this.started;
      await this.client?.closed;
    })();
    return this.closing;
  }

  /** Who someone is, as stv.tf knows them. @param {{ id: string; session: number }} p */
  #idOf(p) {
    return voiceId(this.job.host, p);
  }

  /** How it goes, and who is in the channel: told to stv.tf. */
  #report() {
    const there = this.client?.people() ?? [];
    this.status(
      `${this.job.channel} · ${there.length}`,
      there.map(p => ({ id: this.#idOf(p), name: p.name })),
    );
  }

  async #start() {
    const { job } = this;
    try {
      this.address = await addressOf(job.host, { lookup: this.o.lookup });
      const client = await this.#join();
      if (!client) return;
      if (this.gone) return void client.leave("disconnected");
      client.say(`Recording for ${job.page} (${job.delay ? `delay ${job.delay} s` : "live"})`);
      this.#report();
      this.timers.push(
        setInterval(() => this.forwarder.flush(), FLUSH_MS),
        setInterval(() => this.#report(), STATUS_MS),
      );
    } catch (e) {
      this.gone = true;
      // Told to leave, it has nothing more to say: another may be there by now.
      if (!this.closing) this.status(`Could not join: ${/** @type {Error} */ (e).message}`, []);
    }
  }

  /** In the channel; a name in use (a match before this one, still leaving) is taken with a number. */
  async #join() {
    const name = this.o.name ?? "stv.tf";
    for (let n = 1; ; n++) {
      if (this.gone) return null;
      const client = (this.client = this.#client(n === 1 ? name : `${name} ${n}`));
      try {
        await client.join();
        return client;
      } catch (e) {
        if (/** @type {{ reject?: number }} */ (e).reject !== IN_USE || n >= NAMES) throw e;
      }
    }
  }

  /** @param {string} username */
  #client(username) {
    const { job } = this;
    const c = new MumbleClient({
      host: job.host,
      address: this.address,
      port: job.port,
      username,
      password: job.password || undefined,
      channel: job.channel,
      connect: this.o.connect,
      onVoice: v => this.#voice(v),
      onGone: why => {
        // Only one that was in: a join that fails says so itself.
        if (this.gone || !c.in) return;
        this.gone = true;
        this.timers.forEach(clearInterval);
        this.status(`Left: ${why}`, []);
      },
    });
    return c;
  }

  /** @param {{ session: number; name: string; id: string; opus: Buffer; last: boolean }} v */
  #voice(v) {
    // What comes once told to leave is not passed on.
    if (this.gone) return;
    let packer = this.packers.get(v.session);
    if (!packer) this.packers.set(v.session, (packer = new Twenties()));
    const who = { steamid: null, discord: this.#idOf(v), name: v.name };
    for (const opus of [...packer.push(v.opus), ...(v.last ? packer.flush() : [])]) this.forwarder.frame(who, opus);
  }
}
