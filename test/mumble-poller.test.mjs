import assert from "node:assert/strict";
import { test } from "node:test";
import { JobPoller } from "../src/mumble/poller.mjs";
import { fetchOf, tick, unread, until } from "./stand.mjs";

/** @typedef {import("../src/mumble/job.mjs").Job} Job */
/** @typedef {(text: string, people?: { id: string; name: string }[]) => void} OnStatus */
/** @typedef {{ job: Job; onStatus: OnStatus; delay: number; leave: (why: string) => Promise<void> | void }} Started */
/**
 * @typedef {{
 *   wanted: unknown[]; version: number; down: boolean; fetch: typeof fetch; start: (j: Job, onStatus: OnStatus) => Started | null;
 *   told: { url: string; status?: string; asked?: number; channel?: string; job?: number }[]; started: Started[]; left: [string, string, string][];
 *   logged: string[]; print: (line: string) => void;
 * }} World
 */

/** @param {Record<string, unknown>} [over] */
const job = (over = {}) => ({
  match: "m1",
  invite: "inv",
  host: "mumble.example",
  port: 64738,
  password: "pw",
  channel: "Team A",
  delay: 90,
  ...over,
});

/** A made-up stv.tf (what it wants, what it was told) and made-up Mumble sessions. */
function world() {
  /** @type {World} */
  const w = {
    wanted: [job()],
    version: 1,
    told: [],
    started: [],
    left: [],
    down: false,
    fetch,
    start: () => null,
    logged: [],
    print: () => {},
  };
  w.print = line => void w.logged.push(line);
  w.fetch = fetchOf(async (url, init) => {
    if (w.down) throw new Error("down");
    if (init.method === "POST") {
      w.told.push({ url, ...JSON.parse(init.body) });
      return { ok: true, status: 204 };
    }
    return { ok: true, status: 200, json: async () => ({ jobs: w.wanted, version: w.version }) };
  });
  w.start = (j, onStatus) => {
    /** @type {Started} */
    const s = { job: j, onStatus, delay: j.delay, leave: why => void w.left.push([j.match, j.channel, why]) };
    w.started.push(s);
    onStatus(`In ${j.channel} with 2 people`, [{ id: "mumble:mumble.example:user:1", name: "arie" }]);
    return s;
  };
  return w;
}

test("a channel wanted is joined, with where its voice goes, and the page is told how it goes", async () => {
  const w = world();
  const poller = new JobPoller({ origin: "https://stv.tf", key: "k", fetch: w.fetch, start: w.start, print: w.print });
  await poller.poll();
  assert.equal(w.started.length, 1);
  assert.deepEqual(
    [w.started[0].job.voice, w.started[0].job.host, w.started[0].job.channel, w.started[0].job.invite],
    ["https://stv.tf/w/m1/voice", "mumble.example", "Team A", "inv"],
  );
  assert.deepEqual(w.told, [
    {
      url: "https://stv.tf/w/m1/voice-status",
      invite: "inv",
      kind: "mumble",
      status: "In Team A with 2 people",
      people: [{ id: "mumble:mumble.example:user:1", name: "arie" }],
      channel: "mumble:mumble.example:Team_A",
    },
  ]);
  // Asked again, with what it has: nothing new, nothing done.
  await poller.poll();
  assert.equal(w.started.length, 1);
});

test("one no longer wanted is left; one wanted elsewhere is left and joined anew; a new delay is taken", async () => {
  const w = world();
  const poller = new JobPoller({ origin: "https://stv.tf", key: "k", fetch: w.fetch, start: w.start, print: w.print });
  await poller.poll();
  w.wanted = [job({ delay: 0 })];
  await poller.poll();
  assert.equal(w.started[0].delay, 0, "the same channel: only the delay");
  assert.equal(w.started.length, 1);
  w.wanted = [job({ channel: "Team B" })];
  await poller.poll();
  await tick();
  assert.deepEqual(
    w.left.map(l => l.slice(0, 2)),
    [["m1", "Team A"]],
  );
  assert.equal(w.started.at(-1)?.job.channel, "Team B");
  w.wanted = [];
  await poller.poll();
  assert.deepEqual(
    w.left.map(l => l[1]),
    ["Team A", "Team B"],
  );
});

test("stv.tf not answering sends nobody away", async () => {
  const w = world();
  const poller = new JobPoller({ origin: "https://stv.tf", key: "k", fetch: w.fetch, start: w.start, print: w.print });
  await poller.poll();
  w.down = true;
  await poller.poll();
  assert.equal(w.left.length, 0);
});

test("a server that cannot be joined is said so, and not tried over and over", async () => {
  const w = world();
  w.start = (j, onStatus) => {
    w.started.push({ job: j, onStatus, delay: j.delay, leave: () => {} });
    onStatus("Could not join: the server refused me: Wrong server password");
    return null;
  };
  const poller = new JobPoller({ origin: "https://stv.tf", key: "k", fetch: w.fetch, start: w.start, print: w.print });
  await poller.poll();
  await poller.poll();
  assert.equal(w.started.length, 1);
  assert.match(w.told[0].status ?? "", /Wrong server password/);
});

test("the same channel asked for anew is left and joined again", async () => {
  const w = world();
  const poller = new JobPoller({ origin: "https://stv.tf", key: "k", fetch: w.fetch, start: w.start, print: w.print });
  w.wanted = [job({ asked: 1 })];
  await poller.poll();
  w.wanted = [job({ asked: 2 })];
  await poller.poll();
  await tick();
  assert.deepEqual(
    w.left.map(l => l.slice(0, 2)),
    [["m1", "Team A"]],
  );
  assert.equal(w.started.length, 2);
});

test("whatever stv.tf answers, it keeps asking", async () => {
  for (const answer of [null, { jobs: {} }, { jobs: [{ match: "m1" }] }, { jobs: [null] }, "x"]) {
    const w = world();
    w.fetch = fetchOf(async () => ({ ok: true, status: 200, json: async () => answer }));
    // As the real one does with a job of no channel.
    /** @type {World["start"]} */
    const start = (j, onStatus) => (j.channel.replace(/x/, ""), w.start(j, onStatus));
    const poller = new JobPoller({ origin: "https://stv.tf", key: "k", fetch: w.fetch, start, print: w.print });
    await poller.poll();
  }
});

test("a channel joined anew waits for the old connection to close (both sign in by one name)", async () => {
  const w = world();
  /** @type {() => void} */
  let closed = () => {};
  const start = w.start;
  w.start = (j, onStatus) => {
    const s = /** @type {Started} */ (start(j, onStatus));
    s.leave = why => {
      w.left.push([j.match, j.channel, why]);
      return new Promise(r => (closed = () => r()));
    };
    return s;
  };
  const poller = new JobPoller({ origin: "https://stv.tf", key: "k", fetch: w.fetch, start: w.start, print: w.print });
  await poller.poll();
  w.wanted = [job({ channel: "Team B" })];
  await poller.poll();
  assert.equal(w.started.length, 1, "not while the old one is still connected");
  w.wanted = [job({ channel: "Team B", delay: 5 })];
  await poller.poll();
  closed();
  await tick();
  assert.deepEqual(
    w.started.map(s => [s.job.channel, s.delay]),
    [
      ["Team A", 90],
      ["Team B", 5],
    ],
  );
});

test("what the page is told says which ask, and which channel, it is of", async () => {
  const w = world();
  w.wanted = [job({ asked: 3, channel: "Team A/1" })];
  const poller = new JobPoller({ origin: "https://stv.tf", key: "k", fetch: w.fetch, start: w.start, print: w.print });
  await poller.poll();
  assert.deepEqual([w.told[0].asked, w.told[0].channel], [3, "mumble:mumble.example:Team_A_1"]);
});

test("a stv.tf that refuses the key is asked again much later than one that is down", async () => {
  const w = world();
  const poller = new JobPoller({ origin: "https://stv.tf", key: "k", fetch: w.fetch, start: w.start, print: w.print });
  w.down = true;
  await poller.poll();
  const down = poller.retryIn();
  w.down = false;
  w.fetch = fetchOf(async () => ({ ok: false, status: 401 }));
  const refused = new JobPoller({
    origin: "https://stv.tf",
    key: "wrong",
    fetch: w.fetch,
    start: w.start,
    print: w.print,
  });
  await refused.poll();
  assert.ok(refused.retryIn() >= 20 * down, `${refused.retryIn()} against ${down}`);
});

test("two channels wanted for one match are each sat in, and each left by itself", async () => {
  const w = world();
  const poller = new JobPoller({ origin: "https://stv.tf", key: "k", fetch: w.fetch, start: w.start, print: w.print });
  w.wanted = [job({ job: 1, channel: "Red" }), job({ job: 2, channel: "Blu" })];
  await poller.poll();
  assert.deepEqual(
    w.started.map(s => s.job.channel),
    ["Red", "Blu"],
  );
  assert.deepEqual(
    w.told.map(t => t.job),
    [1, 2],
    "stv.tf is told which of the two each word is of",
  );
  w.wanted = [job({ job: 2, channel: "Blu" })];
  await poller.poll();
  await tick();
  assert.deepEqual(
    w.left.map(l => l[1]),
    ["Red"],
  );
  assert.equal(w.started.length, 2, "the one that stays is not joined anew");
});

test("an answer that is no answer is let go of unread", async () => {
  const w = world();
  const body = unread();
  const poller = new JobPoller({
    origin: "https://stv.tf",
    key: "k",
    fetch: fetchOf(async () => ({ ok: false, status: 502, body })),
    start: w.start,
    print: w.print,
  });
  assert.equal(await poller.poll(), false);
  assert.equal(body.cancelled, true);
});

test("stopped, the question open with stv.tf is let go, and what it answers starts nothing", async () => {
  const w = world();
  /** @type {AbortSignal | undefined} */
  let signal;
  /** @type {(r: unknown) => void} */
  let answer = () => {};
  const fetch = fetchOf((url, init) => ((signal = init.signal), new Promise(r => (answer = r))));
  const poller = new JobPoller({ origin: "https://stv.tf", key: "k", fetch, start: w.start, print: w.print });
  const polled = poller.poll();
  await tick();
  await poller.stop("restarting");
  assert.equal(signal?.aborted, true);
  answer({ ok: true, status: 200, json: async () => ({ jobs: [job()], version: 2 }) });
  assert.equal(await polled, false);
  assert.equal(w.started.length, 0);
});

test("stopped while waiting to ask again, it stops at once", async () => {
  const w = world();
  w.down = true;
  const poller = new JobPoller({ origin: "https://stv.tf", key: "k", fetch: w.fetch, start: w.start, print: w.print });
  let ended = false;
  const running = poller.run().then(() => (ended = true));
  await tick();
  await poller.stop("restarting");
  await until(() => ended);
  await running;
});

test("how stv.tf answers is logged when it changes, and the key never", async () => {
  const w = world();
  const poller = new JobPoller({
    origin: "https://stv.tf",
    key: "SECRET",
    fetch: w.fetch,
    start: w.start,
    print: w.print,
  });
  w.down = true;
  await poller.poll();
  await poller.poll();
  w.down = false;
  await poller.poll();
  await poller.poll();
  assert.deepEqual(w.logged, [
    "stvtf-voice-bot: https://stv.tf/voice/mumble: no answer (down)",
    "stvtf-voice-bot: https://stv.tf/voice/mumble: answering",
  ]);
  assert.ok(!w.logged.join("\n").includes("SECRET"));
});
