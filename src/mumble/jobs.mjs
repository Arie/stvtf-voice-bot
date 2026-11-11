// The Mumble channels stv.tf wants the bot in: asked for on a match's page there, by whoever
// has a say in its voice. The bot keeps a question open with stv.tf (`GET /voice/mumble`), which
// answers the moment something changes, so a channel is joined as it is asked for; and tells it
// how each goes (`POST /voice/mumble`), for the page to show.
import net from "node:net";
import { tell } from "../status.mjs";

// How long stv.tf may keep a question open, and how long to wait after it did not answer.
const ASK_MS = 40_000,
  RETRY_MS = 3000;

/** @typedef {{ match: string; invite: string; host: string; port: number; password: string; channel: string; delay: number; voice: string; page: string }} Job */
/** @typedef {{ delay: number; leave: (why: string) => void }} Session */

/** Whether `ip` is out on the internet: not this machine, its network, or a link's own. @param {string} ip */
export function isPublic(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPublic(mapped[1]);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128) || a >= 224);
  }
  if (!net.isIPv6(ip)) return false;
  const low = ip.toLowerCase();
  return !(low === "::" || low === "::1" || /^f[cd]/.test(low) || /^fe[89ab]/.test(low) || low.startsWith("ff"));
}

/** What makes a job another one: all but its delay. @param {Job} j */
const same = j => [j.host, j.port, j.password, j.channel, j.invite].join("\n");

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
    /** @type {Map<string, { same: string; session: Session | null }>} By match. */
    this.sessions = new Map();
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
    this.version = Number(wanted.version) || 0;
    /** @type {Job[]} */
    const jobs = (wanted.jobs ?? []).map((/** @type {any} */ j) => ({
      ...j,
      page: `${this.o.origin}/w/${j.match}/`,
      voice: `${this.o.origin}/w/${j.match}/voice`,
    }));
    for (const [match, had] of this.sessions) {
      const now = jobs.find(j => j.match === match);
      if (now && same(now) === had.same) continue;
      had.session?.leave(now ? "moved" : "disconnected");
      this.sessions.delete(match);
    }
    for (const job of jobs) {
      const had = this.sessions.get(job.match);
      if (had) {
        if (had.session) had.session.delay = job.delay;
        continue;
      }
      const status = (/** @type {string} */ text, /** @type {{ id: string; name: string }[]} */ people) =>
        this.telling.push(tell({ page: job.page, key: this.o.key, invite: job.invite, fetch: this.o.fetch }, { kind: "mumble", status: text, people }));
      // One that would not be joined is not tried again until it is asked for anew.
      this.sessions.set(job.match, { same: same(job), session: this.o.start(job, status) });
    }
    await Promise.all(this.telling.splice(0));
    return true;
  }

  /** Keeps asking until stopped. */
  async run() {
    while (!this.stopped) if (!(await this.once())) await new Promise(r => setTimeout(r, RETRY_MS));
  }

  /** Leaves every channel. @param {string} why */
  stop(why) {
    this.stopped = true;
    for (const s of this.sessions.values()) s.session?.leave(why);
    this.sessions.clear();
  }
}
