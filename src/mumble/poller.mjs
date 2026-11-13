// The Mumble channels stv.tf wants the bot in: asked for on a match's page there, by whoever
// has a say in its voice. The bot keeps a question open with stv.tf (`GET /voice/mumble`), which
// answers the moment something changes, so a channel is joined as it is asked for; and tells it
// how each goes (`POST <page>voice-status`), for the page to show.
import { setTimeout as sleep } from "node:timers/promises";
import { discard } from "../http.mjs";
import { logOf } from "../log.mjs";
import { postStatus } from "../status.mjs";
import { channelOf, isJob } from "./job.mjs";

/** @typedef {import("./job.mjs").Job} Job */

// How long stv.tf may keep a question open, and how long to wait after it did not answer.
const ASK_MS = 40_000,
  RETRY_MS = 3000,
  // A stv.tf that will not have the key: a wrong one stays wrong.
  REFUSED_MS = 60_000;

/** @typedef {{ delay: number; leave: (why: string) => Promise<void> | void }} Session */
/**
 * A job seen to: its session, once started (after the one before it in that match has closed).
 * @typedef {{ connectionKey: string; job: Job; session: Session | null; left: boolean; ready: Promise<void> }} Entry
 */

/** Which of what is wanted a job is: its match, and which of that match's channels. @param {Job} j */
const keyOf = j => `${j.match}#${j.slot ?? ""}`;

/** What makes a job another one: all but its delay. @param {Job} j */
const connectionKeyOf = j => [j.host, j.port, j.password, j.channel, j.invite, j.asked ?? 0].join("\n");

export class JobPoller {
  /**
   * @param {{
   *   origin: string; key: string; fetch?: typeof fetch; print?: (line: string) => void;
   *   start: (job: Job, onStatus: (text: string, people?: { id: string; name: string }[]) => void) => Session | null;
   * }} o `start` joins a channel (or says why not, and gives none).
   */
  constructor(o) {
    this.o = { fetch, ...o };
    /** How stv.tf answers: logged when it changes. */
    this.log = logOf(`${o.origin}/voice/mumble`, o.print);
    this.version = 0;
    /** @type {Map<string, Entry>} By match and which of its channels (`keyOf`). */
    this.sessions = new Map();
    /** @type {Map<string, Promise<void>>} By the same: the last session left, until it is closed. */
    this.closing = new Map();
    /** @type {Promise<unknown>[]} */
    this.statusPosts = [];
    this.stopped = false;
    /** Ends the question open with stv.tf, and the wait before the next, once stopped. */
    this.aborting = new AbortController();
    /** Whether stv.tf last refused the key. */
    this.refused = false;
  }

  /** Asks what is wanted (waiting for a change, once it knows how things stand) and sees to it. */
  async poll() {
    const jobs = await this.#ask();
    // Stopped meanwhile: what it answers is for nobody.
    if (!jobs || this.stopped) return false;
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
        signal: AbortSignal.any([AbortSignal.timeout(ASK_MS), this.aborting.signal]),
        redirect: "error",
      });
      this.refused = r.status === 401;
      if (!r.ok) {
        this.log(this.refused ? "key refused" : `${r.status} answered`);
        await discard(r);
        return null;
      }
      wanted = await r.json();
    } catch (e) {
      // Not answering is not being told to leave.
      if (!this.stopped) this.log(`no answer (${/** @type {Error} */ (e).message})`);
      return null;
    }
    this.log("answering");
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
      if (!(await this.poll().catch(() => false)))
        await sleep(this.retryIn(), undefined, { signal: this.aborting.signal }).catch(() => {});
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
    this.aborting.abort();
    return Promise.all([...this.sessions].map(([key, had]) => this.#leave(key, had, why)));
  }
}
