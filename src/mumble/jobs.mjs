// The Mumble channels stv.tf wants the bot in: asked for on a match's page there, by whoever
// has a say in its voice. The bot keeps a question open with stv.tf (`GET /voice/mumble`), which
// answers the moment something changes, so a channel is joined as it is asked for; and tells it
// how each goes (`POST <page>voice-status`), for the page to show.
import net from "node:net";
import { postStatus } from "../status.mjs";

// How long stv.tf may keep a question open, and how long to wait after it did not answer.
const ASK_MS = 40_000,
  RETRY_MS = 3000,
  // A stv.tf that will not have the key: a wrong one stays wrong.
  REFUSED_MS = 60_000;

/**
 * A channel wanted, as stv.tf sends it: `job` says which of the match's channels it is.
 * @typedef {{ match: string; invite: string; host: string; port: number; password: string; channel: string; delay: number; asked?: number; job?: number }} Wanted
 */
/** A channel wanted, with where its voice goes; `slot` is the wire's `job`. @typedef {Omit<Wanted, "job"> & { slot?: number; voice: string; page: string }} Job */
/** @typedef {{ delay: number; leave: (why: string) => Promise<void> | void }} Session */
/**
 * A job seen to: its session, once started (after the one before it in that match has closed).
 * @typedef {{ connectionKey: string; job: Job; session: Session | null; left: boolean; ready: Promise<void> }} Entry
 */

/** An IPv6 address (as net.isIPv6 takes it) as its 16 bytes. @param {string} ip */
function ipv6Bytes(ip) {
  // One that ends in IPv4's form: those four bytes as two groups.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  const [a, b, c, d] = v4 ? v4.slice(1).map(Number) : [];
  const text = v4 ? `${ip.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}` : ip;
  const [l, r] = text.split("::");
  const left = l ? l.split(":") : [],
    right = r ? r.split(":") : [];
  const groups = r === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return groups.flatMap(g => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
}

// What is not out on the internet: this machine, its networks, a link's own, multicast and the
// rest of what is set aside; and NAT64 and 6to4, which lead to IPv4 addresses of any kind.
const INSIDE = new net.BlockList();
for (const [ip, bits] of /** @type {[string, number][]} */ ([
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
]))
  INSIDE.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of /** @type {[string, number][]} */ ([
  ["64:ff9b::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]))
  INSIDE.addSubnet(ip, bits, "ipv6");

/**
 * Whether `ip` is out on the internet: not this machine, its network, or a link's own.
 * @param {string} ip @returns {boolean}
 */
export function isPublic(ip) {
  if (net.isIPv4(ip)) return !INSIDE.check(ip, "ipv4");
  if (!net.isIPv6(ip)) return false;
  const x = ipv6Bytes(ip);
  // IPv4 in IPv6 (mapped, or the old compatible form, :: and ::1 among them): as that address.
  if (x.slice(0, 10).every(n => n === 0)) return x[10] === 255 && x[11] === 255 && isPublic(x.slice(12).join("."));
  return !INSIDE.check(ip, "ipv6");
}

/** The channel a job's voice is said to come from, to stv.tf. @param {Job} j */
export const channelOf = j => `mumble:${j.host}:${j.channel.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60)}`;

/** Whether stv.tf's answer holds a job the bot can do. @param {unknown} j @returns {j is Wanted} */
const isJob = j => {
  if (j === null || typeof j !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (j);
  return ["match", "host", "channel"].every(k => typeof o[k] === "string" && o[k]) && Number.isInteger(o.port);
};

/** Which of what is wanted a job is: its match, and which of that match's channels. @param {Job} j */
const keyOf = j => `${j.match}#${j.slot ?? ""}`;

/** What makes a job another one: all but its delay. @param {Job} j */
const connectionKeyOf = j => [j.host, j.port, j.password, j.channel, j.invite, j.asked ?? 0].join("\n");

export class JobPoller {
  /**
   * @param {{
   *   origin: string; key: string; fetch?: typeof fetch;
   *   start: (job: Job, onStatus: (text: string, people?: { id: string; name: string }[]) => void) => Session | null;
   * }} o `start` joins a channel (or says why not, and gives none).
   */
  constructor(o) {
    this.o = { fetch, ...o };
    this.version = 0;
    /** @type {Map<string, Entry>} By match and which of its channels (`keyOf`). */
    this.sessions = new Map();
    /** @type {Map<string, Promise<void>>} By the same: the last session left, until it is closed. */
    this.closing = new Map();
    /** @type {Promise<unknown>[]} */
    this.statusPosts = [];
    this.stopped = false;
    /** Whether stv.tf last refused the key. */
    this.refused = false;
  }

  /** Asks what is wanted (waiting for a change, once it knows how things stand) and sees to it. */
  async poll() {
    const jobs = await this.#ask();
    if (!jobs) return false;
    for (const [key, had] of this.sessions) {
      const now = jobs.find(j => keyOf(j) === key);
      if (now && connectionKeyOf(now) === had.connectionKey) continue;
      this.#leave(key, had, now ? "moved" : "disconnected");
    }
    for (const job of jobs) {
      const had = this.sessions.get(keyOf(job));
      if (!had) this.#startJob(job);
      else {
        had.job.delay = job.delay;
        if (had.session) had.session.delay = job.delay;
      }
    }
    await Promise.all(this.statusPosts.splice(0));
    return true;
  }

  /** What stv.tf wants, or null when it does not answer (or not as it should). @returns {Promise<Job[] | null>} */
  async #ask() {
    let wanted;
    try {
      const r = await this.o.fetch(`${this.o.origin}/voice/mumble?since=${this.version}`, {
        headers: { Authorization: `Bearer ${this.o.key}` },
        signal: AbortSignal.timeout(ASK_MS),
        redirect: "error",
      });
      this.refused = r.status === 401;
      if (!r.ok) return null;
      wanted = await r.json();
    } catch {
      // Not answering is not being told to leave.
      return null;
    }
    const { jobs = [], version } = /** @type {{ jobs?: unknown; version?: unknown }} */ (wanted ?? {});
    if (wanted === null || typeof wanted !== "object" || !Array.isArray(jobs)) return null;
    this.version = Number(version) || 0;
    return jobs.filter(isJob).map(({ job: slot, ...j }) => ({
      ...j,
      slot,
      page: `${this.o.origin}/w/${j.match}/`,
      voice: `${this.o.origin}/w/${j.match}/voice`,
    }));
  }

  /** Joins a job's channel, once the one before it in that match is out. @param {Job} job */
  #startJob(job) {
    /** @type {(text: string, people?: { id: string; name: string }[]) => void} */
    const onStatus = (text, people) =>
      void this.statusPosts.push(
        postStatus(
          { page: job.page, key: this.o.key, invite: job.invite, fetch: this.o.fetch },
          { kind: "mumble", status: text, people, asked: job.asked, job: job.slot, channel: channelOf(job) },
        ),
      );
    /** @type {Entry} */
    const entry = { connectionKey: connectionKeyOf(job), job, session: null, left: false, ready: Promise.resolve() };
    const start = () => {
      if (entry.left) return;
      // One that would not be joined is not tried again until it is asked for anew.
      try {
        entry.session = this.o.start(entry.job, onStatus);
      } catch {
        onStatus("Could not join", []);
      }
    };
    // The one before signs in by the same name: this one goes in once it is out.
    const before = this.closing.get(keyOf(job));
    if (before) entry.ready = before.then(start);
    else start();
    this.sessions.set(keyOf(job), entry);
  }

  /** How long to wait before asking again after no answer, in milliseconds. */
  retryIn() {
    return this.refused ? REFUSED_MS : RETRY_MS;
  }

  /** Keeps asking until stopped. */
  async run() {
    while (!this.stopped)
      if (!(await this.poll().catch(() => false))) await new Promise(r => setTimeout(r, this.retryIn()));
  }

  /** @param {string} key Which it is (`keyOf`). @param {Entry} had @param {string} why */
  #leave(key, had, why) {
    had.left = true;
    this.sessions.delete(key);
    const closed = had.ready.then(() => had.session?.leave(why)).catch(() => {});
    this.closing.set(key, closed);
    closed.then(() => this.closing.get(key) === closed && this.closing.delete(key));
    return closed;
  }

  /** Leaves every channel: resolves once all are closed. @param {string} why */
  stop(why) {
    this.stopped = true;
    return Promise.all([...this.sessions].map(([key, had]) => this.#leave(key, had, why)));
  }
}
