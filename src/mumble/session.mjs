// The bot in one Mumble channel for one match: every speaker's voice regrouped into packets of
// 20 ms and passed to stv.tf, each known by who they are on that server (registered, or their
// certificate), so the match's page can put them on a player and keep them there.
import dns from "node:dns/promises";
import { Forwarder } from "../forward.mjs";
import { MumbleClient } from "./client.mjs";
import { isPublic } from "./jobs.mjs";
import { Twenties } from "./repack.mjs";

// How often what waits is sent, and how often the page is told who is in the channel.
const FLUSH_MS = 100,
  STATUS_MS = 10_000;
// A server on this machine or its network is joined only when said so (for trying it out).
const ANYWHERE = process.env.STVTF_MUMBLE_ANYWHERE === "1";

/**
 * @param {import("./jobs.mjs").Job} job @param {(text: string, people?: { id: string; name: string }[]) => void} status
 * @param {{ key: string; name?: string }} o
 * @returns {import("./jobs.mjs").Session}
 */
export function startSession(job, status, o) {
  const forwarder = new Forwarder({
    url: job.voice,
    key: o.key,
    delay: job.delay,
    invite: job.invite,
    channel: `mumble:${job.host}:${job.channel.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60)}`,
    onStop: why => session.leave(why),
  });
  /** @type {Map<number, Twenties>} By the speaker's session on the server. */
  const packers = new Map();
  /** @type {MumbleClient | null} */
  let client = null;
  /** @type {ReturnType<typeof setInterval>[]} */
  const timers = [];
  let gone = false;
  /** Who someone is on this server, as stv.tf knows them. @param {{ id: string; session: number }} p */
  const idOf = p => `mumble:${job.host}:${(p.id || `session:${p.session}`).replace(/[^A-Za-z0-9:._-]/g, "")}`;
  // How it goes, and who is in the channel: told to stv.tf.
  const report = () => {
    const there = client?.people() ?? [];
    const n = there.length;
    status(`In ${job.channel} on ${job.host} with ${n} ${n === 1 ? "person" : "people"}`, there.map(p => ({ id: idOf(p), name: p.name })));
  };
  const session = {
    get delay() {
      return forwarder.delay;
    },
    set delay(d) {
      if (d === forwarder.delay) return;
      forwarder.delay = d;
      client?.say(`The delay is ${d} s from now on${d ? "" : ": what is said here is heard live"}.`);
    },
    /** @param {string} why */
    leave(why) {
      if (gone) return;
      gone = true;
      timers.forEach(clearInterval);
      forwarder.flush();
      try {
        client?.say(`I am leaving: ${why}`);
      } catch {}
      // The goodbye gets a moment to go out.
      setTimeout(() => client?.leave(why), 200).unref();
    },
  };
  (async () => {
    try {
      const { address } = await dns.lookup(job.host);
      if (!isPublic(address) && !ANYWHERE) throw new Error("that server is not out on the internet");
      client = new MumbleClient({
        host: job.host,
        port: job.port,
        username: o.name ?? "stv.tf",
        password: job.password || undefined,
        channel: job.channel,
        onVoice: v => {
          const packer = packers.get(v.session) ?? packers.set(v.session, new Twenties()).get(v.session);
          const who = { steamid: null, discord: idOf(v), name: v.name };
          for (const opus of [.../** @type {Twenties} */ (packer).push(v.opus), ...(v.last ? /** @type {Twenties} */ (packer).flush() : [])])
            forwarder.frame(who, opus);
        },
        onGone: why => {
          if (gone) return;
          gone = true;
          timers.forEach(clearInterval);
          status(`Left: ${why}`, []);
        },
      });
      await client.join();
      if (gone) return client.leave("asked to leave meanwhile");
      const how = job.delay ? `${job.delay} s behind, with the match's SourceTV` : "live";
      client.say(`Recording this channel for ${job.page}: what is said here is heard there by everyone watching, ${how}.`);
      report();
      timers.push(setInterval(() => forwarder.flush(), FLUSH_MS), setInterval(report, STATUS_MS));
    } catch (e) {
      gone = true;
      status(`Could not join: ${/** @type {Error} */ (e).message}`, []);
    }
  })();
  return session;
}
