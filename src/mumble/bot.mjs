// The bot in Mumble: every stv.tf says which channels it wants the bot in (asked for on a match's
// page), and the bot sits in each, marked as recording, passing what is said to that match.
import { originOf } from "../match.mjs";
import { JobPoller } from "./poller.mjs";
import { startSession } from "./session.mjs";

/**
 * Asks each of `hosts` which channels are wanted, and sees to them, with `key`; `anywhere`, a
 * server may be on this machine or its network. Its `stop` leaves every channel.
 * @param {{ hosts: string[]; key: string; anywhere: boolean }} o
 * @returns {{ stop: (why: string) => Promise<unknown> }}
 */
export function startMumble({ hosts, key, anywhere }) {
  const pollers = hosts.map(
    host =>
      new JobPoller({
        origin: originOf(host),
        key,
        start: (job, onStatus) => startSession(job, onStatus, { key, anywhere }),
      }),
  );
  for (const poller of pollers) poller.run();
  return { stop: why => Promise.all(pollers.map(poller => poller.stop(why))) };
}
