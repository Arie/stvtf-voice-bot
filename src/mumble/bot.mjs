// The bot in Mumble: every stv.tf says which channels it wants the bot in (asked for on a match's
// page), and the bot sits in each, marked as recording, passing what is said to that match.
import { homeOf } from "../match.mjs";
import { Jobs } from "./jobs.mjs";
import { startSession } from "./session.mjs";

/**
 * Asks each of `hosts` which channels are wanted, and sees to them, with `key`. Its `stop`
 * leaves every channel.
 * @param {{ hosts: string[]; key: string }} o
 * @returns {{ stop: (why: string) => Promise<unknown> }}
 */
export function startMumble({ hosts, key }) {
  const all = hosts.map(
    host => new Jobs({ origin: homeOf([host]), key, start: (job, onStatus) => startSession(job, onStatus, { key }) }),
  );
  for (const jobs of all) jobs.run();
  return { stop: why => Promise.all(all.map(jobs => jobs.stop(why))) };
}
