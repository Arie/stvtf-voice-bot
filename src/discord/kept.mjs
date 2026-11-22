// The Discord channels the bot is in, kept in a file: after a restart it goes back into them.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { fault } from "../fault.mjs";

/** A channel the bot is in: its server, the voice channel, the match's link as given, the delay. @typedef {{ guild: string; channel: string; link: string; delay: number }} KeptChannel */

export class Kept {
  /** @param {string | null} path The file they are saved in; null keeps them in memory only. */
  constructor(path) {
    this.path = path;
    /** Set when the bot is stopping: channels it leaves from then on stay saved, to rejoin. */
    this.stopping = false;
    /** @type {Map<string, KeptChannel>} By server. */
    this.channels = new Map();
    if (!path) return;
    try {
      for (const c of JSON.parse(readFileSync(path, "utf8"))) if (isKept(c)) this.channels.set(c.guild, c);
    } catch {
      // No file yet, or it cannot be read: there are no channels to rejoin.
    }
  }

  /** @returns {KeptChannel[]} */
  list() {
    return [...this.channels.values()];
  }

  /** @param {KeptChannel} c */
  add(c) {
    this.channels.set(c.guild, c);
    this.#write();
  }

  /** Removes the channel of `guild`, which the bot left for good. Does nothing while it is stopping. @param {string} guild */
  forget(guild) {
    if (!this.stopping && this.channels.delete(guild)) this.#write();
  }

  /** @param {string} guild @param {number} delay */
  setDelay(guild, delay) {
    const c = this.channels.get(guild);
    if (!c || c.delay === delay) return;
    c.delay = delay;
    this.#write();
  }

  #write() {
    if (!this.path) return;
    try {
      writeFileSync(`${this.path}.part`, JSON.stringify(this.list()));
      renameSync(`${this.path}.part`, this.path);
    } catch (e) {
      fault(this.path, e);
    }
  }
}

/** @param {unknown} c @returns {c is KeptChannel} */
function isKept(c) {
  if (!c || typeof c !== "object") return false;
  const k = /** @type {Record<string, unknown>} */ (c);
  return [k.guild, k.channel, k.link].every(v => typeof v === "string") && typeof k.delay === "number";
}
