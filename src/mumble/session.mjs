// The bot in one Mumble channel for one match: every speaker's voice is regrouped into packets
// of 20 ms and passed to stv.tf. Each speaker is identified by their certificate, or else by their
// registration on that server, so the match's page can assign them to a player and keep them there.
import { Forwarder } from "../stvtf/forward.mjs";
import { logOf } from "../log.mjs";
import { STATE } from "../stvtf/status.mjs";
import { PAGE } from "./certs.mjs";
import { MumbleClient, voiceId } from "./client.mjs";
import { addressOf } from "./address.mjs";
import { channelOf, nameOf } from "./job.mjs";
import { Repacker20ms } from "./repack.mjs";

// How often what waits is sent, and how often the page is told who is in the channel.
const FLUSH_MS = 100,
  STATUS_MS = 10_000;
// Mumble's Reject.UsernameInUse, and WrongUserPW (the name is registered to another).
const IN_USE = 5,
  ANOTHERS = 3;
/** @typedef {(state: import("../stvtf/status.mjs").State, text: string, people?: { id: string; name: string }[]) => void} OnStatus */
/**
 * @typedef {{ key: string; anywhere?: boolean; name?: string; identities?: import("./certs.mjs").Identities; lookup?: import("./address.mjs").Lookup; connect?: () => import("node:stream").Duplex;
 *   fetch?: typeof fetch; pause?: (ms: number) => Promise<void>; print?: (line: string) => void }} Options
 *   `lookup`, `connect`, `fetch`, `pause` and `print` are for tests.
 */

/**
 * @param {import("./job.mjs").Job} job @param {OnStatus} onStatus @param {Options} o
 * @returns {import("./poller.mjs").Session}
 */
export function startSession(job, onStatus, o) {
  return new MumbleSession(job, onStatus, o);
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
  /** @type {Map<number, Repacker20ms>} By the speaker's session on the server. */
  packers = new Map();
  /** @type {string | undefined} */
  address;
  /** @type {ReturnType<import("./certs.mjs").Identities["take"]>} Its certificate, if any. */
  identity = null;

  /** @param {import("./job.mjs").Job} job @param {OnStatus} onStatus @param {Options} o */
  constructor(job, onStatus, o) {
    this.job = job;
    this.o = o;
    // Two logs: the session's status, and what stv.tf answers to voice posts. Each prints a line
    // when it changes.
    const where = `${channelOf(job)} → ${job.page}`;
    this.logStatus = logOf(where, o.print);
    /** @type {OnStatus} */
    this.onStatus = (state, text, people) => {
      this.logStatus(text);
      onStatus(state, text, people);
    };
    this.logAnswer = logOf(where, o.print);
    this.forwarder = new Forwarder({
      url: job.voice,
      key: o.key,
      delay: job.delay,
      invite: job.invite,
      fetch: o.fetch,
      channel: channelOf(job),
      onStop: why => this.leave(why),
      onAnswer: answer => this.logAnswer(answer),
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
    this.logStatus(`Leaving: ${why}`);
    this.gone = true;
    this.timers.forEach(clearInterval);
    this.forwarder.stop();
    this.closing = (async () => {
      if (this.client?.inChannel) {
        this.client.say(`Leaving: ${why}`);
        // The goodbye gets a moment to go out.
        await (this.o.pause ?? (ms => new Promise(r => setTimeout(r, ms))))(200);
      }
      this.client?.leave(why);
      // A join in progress ends once its connection is closed. One that has not begun will not
      // begin, because `gone` is set.
      await this.started;
      await this.client?.closed;
    })();
    return this.closing;
  }

  /** Who someone is, as stv.tf knows them. @param {{ id: string; session: number }} p */
  #idOf(p) {
    return voiceId(this.job.host, p);
  }

  /** Tells stv.tf the status and who is in the channel. */
  #reportStatus() {
    const there = this.client?.people() ?? [];
    this.onStatus(
      STATE.in,
      `${this.job.channel} · ${there.length}`,
      there.map(p => ({ id: this.#idOf(p), name: p.name })),
    );
  }

  async #start() {
    const { job } = this;
    try {
      this.address = await addressOf(job.host, { lookup: this.o.lookup, anywhere: this.o.anywhere });
      // Keyed by address, so a server reached under two names counts as one.
      this.identity = this.o.identities?.take(`${this.address}:${job.port}`) ?? null;
      const client = await this.#join();
      if (!client) return;
      if (this.gone) return void client.leave("disconnected");
      if (this.identity) client.describe(`stv.tf voice bot · ${PAGE}`);
      client.say(`Recording for ${job.page} (${job.delay ? `delay ${job.delay} s` : "live"})`);
      this.#reportStatus();
      this.timers.push(
        setInterval(() => this.forwarder.flush(), FLUSH_MS),
        setInterval(() => this.#reportStatus(), STATUS_MS),
      );
    } catch (e) {
      this.gone = true;
      // If it was told to leave it reports nothing: another session may have taken its place by now.
      if (!this.closing) this.onStatus(STATE.failed, `Could not join: ${/** @type {Error} */ (e).message}`, []);
    } finally {
      // Its certificate is free once the connection is closed.
      const { identity } = this;
      void (this.client?.closed ?? Promise.resolve()).then(() => identity?.release());
    }
  }

  /** Joins the channel by the certificate's name; if that name is taken, by the match's; then that with a letter after. */
  async #join() {
    const own = this.o.name ?? nameOf(this.job);
    const names = [...(this.identity ? [this.identity.name] : []), own, `${own}-b`, `${own}-c`];
    for (const [n, name] of names.entries()) {
      if (this.gone) return null;
      const client = (this.client = this.#client(name));
      try {
        await client.join();
        return client;
      } catch (e) {
        const { reject } = /** @type {{ reject?: number }} */ (e);
        if ((reject !== IN_USE && reject !== ANOTHERS) || n === names.length - 1) throw e;
      }
    }
    return null;
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
      cert: this.identity?.cert,
      key: this.identity?.key,
      channel: job.channel,
      connect: this.o.connect,
      onVoice: v => this.#voice(v),
      onGone: why => {
        // Only for a client that was in the channel: a failed join is reported by #start.
        if (this.gone || !c.inChannel) return;
        this.gone = true;
        this.timers.forEach(clearInterval);
        this.forwarder.stop();
        this.onStatus(STATE.left, `Left: ${why}`, []);
      },
    });
    return c;
  }

  /** @param {{ session: number; name: string; id: string; opus: Buffer; last: boolean }} v */
  #voice(v) {
    // What comes once told to leave is not passed on.
    if (this.gone) return;
    let packer = this.packers.get(v.session);
    if (!packer) this.packers.set(v.session, (packer = new Repacker20ms()));
    const who = { steamid: null, id: this.#idOf(v), name: v.name };
    for (const opus of [...packer.push(v.opus), ...(v.last ? packer.flush() : [])]) this.forwarder.add(who, opus);
  }
}
