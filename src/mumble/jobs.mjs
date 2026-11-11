// The Mumble channels stv.tf wants the bot in: asked for on a match's page there, by whoever
// has a say in its voice. The bot keeps a question open with stv.tf (`GET /voice/mumble`), which
// answers the moment something changes, so a channel is joined as it is asked for; and tells it
// how each goes (`POST /voice/mumble`), for the page to show.
import net from "node:net";
import { tell } from "../status.mjs";

// How long stv.tf may keep a question open, and how long to wait after it did not answer.
const ASK_MS = 40_000,
  RETRY_MS = 3000;

/** @typedef {{ match: string; invite: string; host: string; port: number; password: string; channel: string; delay: number; asked?: number; voice: string; page: string }} Job */
/** @typedef {{ delay: number; leave: (why: string) => Promise<void> | void }} Session */
/**
 * A job seen to: its session, once started (after the one before it in that match has closed).
 * @typedef {{ same: string; job: Job; session: Session | null; left: boolean; ready: Promise<void> }} Entry
 */

/** An IPv6 address (as net.isIPv6 takes it) as its 16 bytes. @param {string} ip */
function bytes6(ip) {
  // One that ends in IPv4's form: those four bytes as two groups.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  const text = v4
    ? ip.slice(0, v4.index) + ((+v4[1] << 8) | +v4[2]).toString(16) + ":" + ((+v4[3] << 8) | +v4[4]).toString(16)
    : ip;
  const [l, r] = text.split("::");
  const left = l ? l.split(":") : [],
    right = r ? r.split(":") : [];
  const groups = r === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return groups.flatMap(g => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
}

/** Whether `ip` is out on the internet: not this machine, its network, or a link's own. @param {string} ip */
export function isPublic(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b < 32) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b < 128) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 0 && c === 0) ||
      a >= 224
    );
  }
  if (!net.isIPv6(ip)) return false;
  const x = bytes6(ip);
  const word = (/** @type {number} */ i) => x[i] * 256 + x[i + 1];
  // IPv4 in IPv6 (mapped, or the old compatible form): as that address.
  if (x.slice(0, 10).every(b => b === 0)) return word(10) === 0xffff && isPublic(x.slice(12).join("."));
  // NAT64 and 6to4 lead to IPv4 addresses of any kind.
  if (word(0) === 0x64 && word(2) === 0xff9b) return false;
  if (word(0) === 0x2002) return false;
  return !((x[0] & 0xfe) === 0xfc || (x[0] === 0xfe && (x[1] & 0xc0) === 0x80) || x[0] === 0xff);
}

/** The channel a job's voice is said to come from, to stv.tf. @param {Job} j */
export const channelOf = j => `mumble:${j.host}:${j.channel.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60)}`;

/** Whether stv.tf's answer holds a job the bot can do. @param {any} j @returns {j is Job} */
const whole = j =>
  j != null &&
  typeof j === "object" &&
  ["match", "host", "channel"].every(k => typeof j[k] === "string" && j[k]) &&
  Number.isInteger(j.port);

/** What makes a job another one: all but its delay. @param {Job} j */
const same = j => [j.host, j.port, j.password, j.channel, j.invite, j.asked ?? 0].join("\n");

export class Jobs {
  /**
   * @param {{
   *   origin: string; key: string; fetch?: typeof fetch;
   *   start: (job: Job, status: (text: string, people?: { id: string; name: string }[]) => void) => Session | null;
   * }} o `start` joins a channel (or says why not, and gives none).
   */
  constructor(o) {
    this.o = { fetch, ...o };
    this.version = 0;
    /** @type {Map<string, Entry>} By match. */
    this.sessions = new Map();
    /** @type {Map<string, Promise<void>>} By match: the last session left, until it is closed. */
    this.closing = new Map();
    /** @type {Promise<unknown>[]} */
    this.telling = [];
    this.stopped = false;
  }

  /** Asks what is wanted (waiting for a change, once it knows how things stand) and sees to it. */
  async once() {
    let wanted;
    try {
      const r = await this.o.fetch(`${this.o.origin}/voice/mumble?since=${this.version}`, {
        headers: { Authorization: `Bearer ${this.o.key}` },
        signal: AbortSignal.timeout(ASK_MS),
        redirect: "error",
      });
      if (!r.ok) return false;
      wanted = await r.json();
    } catch {
      // Not answering is not being told to leave.
      return false;
    }
    if (wanted == null || typeof wanted !== "object" || !Array.isArray(wanted.jobs ?? [])) return false;
    this.version = Number(wanted.version) || 0;
    /** @type {Job[]} */
    const jobs = (wanted.jobs ?? []).filter(whole).map((/** @type {any} */ j) => ({
      ...j,
      page: `${this.o.origin}/w/${j.match}/`,
      voice: `${this.o.origin}/w/${j.match}/voice`,
    }));
    for (const [match, had] of this.sessions) {
      const now = jobs.find(j => j.match === match);
      if (now && same(now) === had.same) continue;
      this.#leave(match, had, now ? "moved" : "disconnected");
    }
    for (const job of jobs) {
      const had = this.sessions.get(job.match);
      if (had) {
        had.job.delay = job.delay;
        if (had.session) had.session.delay = job.delay;
        continue;
      }
      const status = (/** @type {string} */ text, /** @type {{ id: string; name: string }[]} */ people) =>
        this.telling.push(
          tell(
            { page: job.page, key: this.o.key, invite: job.invite, fetch: this.o.fetch },
            { kind: "mumble", status: text, people, asked: job.asked, channel: channelOf(job) },
          ),
        );
      /** @type {Entry} */
      const entry = { same: same(job), job, session: null, left: false, ready: Promise.resolve() };
      const begin = () => {
        if (entry.left) return;
        // One that would not be joined is not tried again until it is asked for anew.
        try {
          entry.session = this.o.start(entry.job, status);
        } catch {
          status("Could not join", []);
        }
      };
      // The one before signs in by the same name: this one goes in once it is out.
      const before = this.closing.get(job.match);
      if (before) entry.ready = before.then(begin);
      else begin();
      this.sessions.set(job.match, entry);
    }
    await Promise.all(this.telling.splice(0));
    return true;
  }

  /** Keeps asking until stopped. */
  async run() {
    while (!this.stopped) if (!(await this.once().catch(() => false))) await new Promise(r => setTimeout(r, RETRY_MS));
  }

  /** @param {string} match @param {Entry} had @param {string} why */
  #leave(match, had, why) {
    had.left = true;
    this.sessions.delete(match);
    const closed = had.ready.then(() => had.session?.leave(why)).catch(() => {});
    this.closing.set(match, closed);
    closed.then(() => this.closing.get(match) === closed && this.closing.delete(match));
    return closed;
  }

  /** Leaves every channel: resolves once all are closed. @param {string} why */
  stop(why) {
    this.stopped = true;
    return Promise.all([...this.sessions].map(([match, had]) => this.#leave(match, had, why)));
  }
}
