import assert from "node:assert/strict";
import { test } from "node:test";
import { Jobs, isPublic } from "../src/mumble/jobs.mjs";

const tick = () => new Promise(r => setImmediate(r));
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
  const w = { wanted: [job()], version: 1, told: [], started: [], left: [], down: false };
  w.fetch = async (url, init = {}) => {
    if (w.down) throw new Error("down");
    if (init.method === "POST") {
      w.told.push({ url, ...JSON.parse(init.body) });
      return { ok: true, status: 204 };
    }
    return { ok: true, status: 200, json: async () => ({ jobs: w.wanted, version: w.version }) };
  };
  w.start = (j, status) => {
    const s = { job: j, status, delay: j.delay, leave: why => w.left.push([j.match, j.channel, why]) };
    w.started.push(s);
    status(`In ${j.channel} with 2 people`, [{ id: "mumble:mumble.example:user:1", name: "arie" }]);
    return s;
  };
  return w;
}

test("a channel wanted is joined, with where its voice goes, and the page is told how it goes", async () => {
  const w = world();
  const jobs = new Jobs({ origin: "https://stv.tf", key: "k", fetch: w.fetch, start: w.start });
  await jobs.once();
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
  await jobs.once();
  assert.equal(w.started.length, 1);
});

test("one no longer wanted is left; one wanted elsewhere is left and joined anew; a new delay is taken", async () => {
  const w = world();
  const jobs = new Jobs({ origin: "https://stv.tf", key: "k", fetch: w.fetch, start: w.start });
  await jobs.once();
  w.wanted = [job({ delay: 0 })];
  await jobs.once();
  assert.equal(w.started[0].delay, 0, "the same channel: only the delay");
  assert.equal(w.started.length, 1);
  w.wanted = [job({ channel: "Team B" })];
  await jobs.once();
  await tick();
  assert.deepEqual(
    w.left.map(l => l.slice(0, 2)),
    [["m1", "Team A"]],
  );
  assert.equal(w.started.at(-1).job.channel, "Team B");
  w.wanted = [];
  await jobs.once();
  assert.deepEqual(
    w.left.map(l => l[1]),
    ["Team A", "Team B"],
  );
});

test("stv.tf not answering sends nobody away", async () => {
  const w = world();
  const jobs = new Jobs({ origin: "https://stv.tf", key: "k", fetch: w.fetch, start: w.start });
  await jobs.once();
  w.down = true;
  await jobs.once();
  assert.equal(w.left.length, 0);
});

test("a server that cannot be joined is said so, and not tried over and over", async () => {
  const w = world();
  w.start = (j, status) => {
    w.started.push(j);
    status("Could not join: the server refused me: Wrong server password");
    return null;
  };
  const jobs = new Jobs({ origin: "https://stv.tf", key: "k", fetch: w.fetch, start: w.start });
  await jobs.once();
  await jobs.once();
  assert.equal(w.started.length, 1);
  assert.match(w.told[0].status, /Wrong server password/);
});

test("only servers out on the internet are joined", () => {
  for (const ip of ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]) assert.equal(isPublic(ip), true, ip);
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "192.168.1.12",
    "172.16.0.1",
    "169.254.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:10.0.0.1",
  ])
    assert.equal(isPublic(ip), false, ip);
});

test("the same channel asked for anew is left and joined again", async () => {
  const w = world();
  const jobs = new Jobs({ origin: "https://stv.tf", key: "k", fetch: w.fetch, start: w.start });
  w.wanted = [job({ asked: 1 })];
  await jobs.once();
  w.wanted = [job({ asked: 2 })];
  await jobs.once();
  await tick();
  assert.deepEqual(
    w.left.map(l => l.slice(0, 2)),
    [["m1", "Team A"]],
  );
  assert.equal(w.started.length, 2);
});

test("nor any range that leads back in: benchmarking, IETF, NAT64, 6to4, IPv4 in IPv6 however written", () => {
  for (const ip of [
    "198.18.0.1",
    "198.19.255.1",
    "192.0.0.8",
    "64:ff9b::a00:1",
    "64:ff9b::808:808",
    "2002:a00:1::1",
    "::ffff:a00:1",
    "::ffff:127.0.0.1",
    "0:0:0:0:0:ffff:7f00:1",
    "::127.0.0.1",
    "::",
  ])
    assert.equal(isPublic(ip), false, ip);
  for (const ip of ["198.20.0.1", "192.0.1.1", "::ffff:8.8.8.8", "2001:4860:4860::8888"])
    assert.equal(isPublic(ip), true, ip);
});

test("whatever stv.tf answers, it keeps asking", async () => {
  for (const answer of [null, { jobs: {} }, { jobs: [{ match: "m1" }] }, { jobs: [null] }, "x"]) {
    const w = world();
    w.fetch = async () => ({ ok: true, status: 200, json: async () => answer });
    // As the real one does with a job of no channel.
    const start = (j, status) => (j.channel.replace(/x/, ""), w.start(j, status));
    const jobs = new Jobs({ origin: "https://stv.tf", key: "k", fetch: w.fetch, start });
    await jobs.once();
  }
});

test("a channel joined anew waits for the old connection to close (both sign in by one name)", async () => {
  const w = world();
  /** @type {() => void} */
  let closed = () => {};
  const start = w.start;
  w.start = (j, status) =>
    Object.assign(start(j, status), {
      leave: why => (w.left.push([j.match, j.channel, why]), new Promise(r => (closed = r))),
    });
  const jobs = new Jobs({ origin: "https://stv.tf", key: "k", fetch: w.fetch, start: w.start });
  await jobs.once();
  w.wanted = [job({ channel: "Team B" })];
  await jobs.once();
  assert.equal(w.started.length, 1, "not while the old one is still connected");
  w.wanted = [job({ channel: "Team B", delay: 5 })];
  await jobs.once();
  closed();
  await new Promise(r => setImmediate(r));
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
  const jobs = new Jobs({ origin: "https://stv.tf", key: "k", fetch: w.fetch, start: w.start });
  await jobs.once();
  assert.deepEqual([w.told[0].asked, w.told[0].channel], [3, "mumble:mumble.example:Team_A_1"]);
});
