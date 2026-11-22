// The Mumble channels stv.tf wants the bot in. They are requested on a match's page there, by
// whoever may manage its voice. The bot long-polls stv.tf (`GET /voice/mumble`), which answers
// the moment something changes, so a channel is joined as soon as it is requested. The bot
// reports each channel's status (`POST <page>voice-status`), for the page to show.
import { setTimeout as sleep } from "node:timers/promises";
import { discard } from "../http.mjs";
import { logOf } from "../log.mjs";
import { STATE, postStatus } from "../stvtf/status.mjs";
import { channelOf, isJob } from "./job.mjs";

/** @typedef {import("./job.mjs").Job} Job */

// How long stv.tf may hold a long poll open, and how long to wait after it did not answer.
const ASK_MS = 40_000,
  RETRY_MS = 3000,
  // How long to wait after stv.tf refused the key: a wrong key stays wrong.
  REFUSED_MS = 60_000;

/** @typedef {{ delay: number; leave: (why: string) => Promise<void> | void }} Session */
/**
 * A job being handled, with its session once started. It starts after the previous session for
 * the same match and channel slot has closed.
 * @typedef {{ connectionKey: string; job: Job; session: Session | null; left: boolean; ready: Promise<void> }} Entry
 */

/** Identifies a job: its match, and which of that match's channels (the slot). @param {Job} j */
const keyOf = j => `${j.match}#${j.slot ?? ""}`;

/** What makes a job need a new connection when it changes: everything but its delay. @param {Job} j */
const connectionKeyOf = j => [j.host, j.port, j.password, j.channel, j.invite, j.asked ?? 0].join("\n");

export class JobPoller {
  /**
   * @param {{
   *   origin: string; key: string; fetch?: typeof fetch; print?: (line: string) => void;
   *   start: (job: Job, onStatus: import("./session.mjs").OnStatus) => Session | null;
   * }} o `start` joins a channel (or reports why not, and returns null).
   */
  constructor(o) {
    this.o = { fetch, ...o };
    /** How stv.tf answers: logged when it changes. */
    this.log = logOf(`${o.origin}/voice/mumble`, o.print);
    this.version = 0;
    /** @type {Map<string, Entry>} By match and which of its channels (`keyOf`). */
    this.sessions = new Map();
    /** @type {Map<string, Promise<void>>} By the same key: the session last left, until its connection is closed. */
    this.closing = new Map();
    /** @type {Promise<unknown>[]} */
    this.statusPosts = [];
    this.stopped = false;
    /** Aborts the open long poll, and the wait before the next one, when stopped. */
    this.aborting = new AbortController();
    /** Whether stv.tf last refused the key. */
    this.refused = false;
  }

  /** Asks what is wanted and acts on it. Once it has a version, stv.tf holds the request until something changes. */
  async poll() {
    const jobs = await this.#ask();
    // Stopped meanwhile: the answer is ignored.
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
      // No answer does not mean the bot must leave: its sessions stay.
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

  /** Joins a job's channel, once the previous session for the same match and slot has closed. @param {Job} job */
  #startJob(job) {
    /** @type {import("./session.mjs").OnStatus} */
    const onStatus = (state, text, people) =>
      void this.statusPosts.push(
        postStatus(
          { page: job.page, key: this.o.key, invite: job.invite, fetch: this.o.fetch },
          { kind: "mumble", state, status: text, people, asked: job.asked, job: job.slot, channel: channelOf(job) },
        ),
      );
    /** @type {Entry} */
    const entry = { connectionKey: connectionKeyOf(job), job, session: null, left: false, ready: Promise.resolve() };
    const start = () => {
      if (entry.left) return;
      // A channel that could not be joined is not tried again until it is requested anew.
      try {
        entry.session = this.o.start(entry.job, onStatus);
      } catch {
        onStatus(STATE.failed, "Could not join", []);
      }
    };
    // The previous session signs in with the same name: this one starts once that one has closed.
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
