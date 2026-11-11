// The bot in one Mumble channel for one match: every speaker's voice regrouped into packets of
// 20 ms and passed to stv.tf, each known by who they are on that server (registered, or their
// certificate), so the match's page can put them on a player and keep them there.
import dns from "node:dns/promises";
import { Forwarder } from "../forward.mjs";
import { MumbleClient, voiceId } from "./client.mjs";
import { isPublic } from "./jobs.mjs";
import { Twenties } from "./repack.mjs";

// How often what waits is sent, and how often the page is told who is in the channel.
const FLUSH_MS = 100,
  STATUS_MS = 10_000;
// What a name in use is refused as (Mumble's Reject.UsernameInUse), and how many names are tried.
const IN_USE = 5,
  NAMES = 3;
// A server on this machine or its network is joined only when said so (for trying it out).
const ANYWHERE = process.env.STVTF_MUMBLE_ANYWHERE === "1";

/**
 * Where to reach `host`: one of its addresses, once every one is known to be out on the internet
 * (a name can give one public and one private, and a second lookup another).
 * @param {string} host @param {{ lookup?: typeof dns.lookup; anywhere?: boolean }} [o]
 */
export async function addressOf(host, { lookup = dns.lookup, anywhere = ANYWHERE } = {}) {
  const all = await lookup(host, { all: true });
  if (!all.length) throw new Error("no address");
  if (!anywhere && !all.every(a => isPublic(a.address))) throw new Error("private address");
  return all[0].address;
}

/**
 * @param {import("./jobs.mjs").Job} job @param {(text: string, people?: { id: string; name: string }[]) => void} status
 * @param {{ key: string; name?: string; lookup?: typeof dns.lookup; connect?: () => import("node:stream").Duplex; fetch?: typeof fetch }} o
 * `lookup`, `connect` and `fetch` are for tests.
 * @returns {import("./jobs.mjs").Session}
 */
export function startSession(job, status, o) {
  const forwarder = new Forwarder({
    url: job.voice,
    key: o.key,
    delay: job.delay,
    invite: job.invite,
    fetch: o.fetch,
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
  /** @type {Promise<void> | null} */
  let closing = null;
  /** Who someone is, as stv.tf knows them. @param {{ id: string; session: number }} p */
  const idOf = p => voiceId(job.host, p);
  // How it goes, and who is in the channel: told to stv.tf.
  const report = () => {
    const there = client?.people() ?? [];
    const n = there.length;
    status(`${job.channel} · ${n}`, there.map(p => ({ id: idOf(p), name: p.name })));
  };
  const session = {
    get delay() {
      return forwarder.delay;
    },
    set delay(d) {
      if (d === forwarder.delay) return;
      forwarder.delay = d;
      client?.say(`tv_delay: ${d} s${d ? "" : " (live)"}`);
    },
    /** @param {string} why @returns {Promise<void>} Once its connection is closed. */
    leave(why) {
      if (closing) return closing;
      gone = true;
      timers.forEach(clearInterval);
      forwarder.flush();
      closing = (async () => {
        if (client?.in) {
          client.say(`Leaving: ${why}`);
          // The goodbye gets a moment to go out.
          await new Promise(r => setTimeout(r, 200));
        }
        client?.leave(why);
        // A join under way ends once its connection is closed; one not yet begun is not begun.
        await started;
        await client?.closed;
      })();
      return closing;
    },
  };
  /** @param {string} username */
  const connect = username => {
    const c = new MumbleClient({
      host: job.host,
      address,
      port: job.port,
      username,
      password: job.password || undefined,
      channel: job.channel,
      connect: o.connect,
      onVoice: v => {
        // What comes once told to leave is not passed on.
        if (gone) return;
        const packer = packers.get(v.session) ?? packers.set(v.session, new Twenties()).get(v.session);
        const who = { steamid: null, discord: idOf(v), name: v.name };
        for (const opus of [.../** @type {Twenties} */ (packer).push(v.opus), ...(v.last ? /** @type {Twenties} */ (packer).flush() : [])])
          forwarder.frame(who, opus);
      },
      onGone: why => {
        // Only one that was in: a join that fails says so itself.
        if (gone || !c.in) return;
        gone = true;
        timers.forEach(clearInterval);
        status(`Left: ${why}`, []);
      },
    });
    return c;
  };
  /** @type {string | undefined} */
  let address;
  const started = (async () => {
    try {
      address = await addressOf(job.host, { lookup: o.lookup });
      // A name in use (a match before this one, still leaving) is taken with a number.
      const name = o.name ?? "stv.tf";
      for (let n = 1; ; n++) {
        if (gone) return;
        client = connect(n === 1 ? name : `${name} ${n}`);
        try {
          await client.join();
          break;
        } catch (e) {
          if (/** @type {any} */ (e).reject !== IN_USE || n >= NAMES) throw e;
        }
      }
      if (gone) return void client.leave("disconnected");
      client.say(`Recording for ${job.page} (${job.delay ? `delay ${job.delay} s` : "live"})`);
      report();
      timers.push(setInterval(() => forwarder.flush(), FLUSH_MS), setInterval(report, STATUS_MS));
    } catch (e) {
      gone = true;
      status(`Could not join: ${/** @type {Error} */ (e).message}`, []);
    }
  })();
  return session;
}
