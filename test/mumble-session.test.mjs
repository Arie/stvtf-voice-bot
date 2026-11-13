import assert from "node:assert/strict";
import { test } from "node:test";
import { tlsOptions } from "../src/mumble/client.mjs";
import { nameOf } from "../src/mumble/job.mjs";
import { startSession } from "../src/mumble/session.mjs";
import { fake, lookupOf, welcomeIn } from "./fake-mumble.mjs";
import { fetchOf, tick, until } from "./stand.mjs";

/** @typedef {import("./fake-mumble.mjs").Server} Server */

test("the connection goes to that address, its name the server's for TLS", () => {
  assert.deepEqual(tlsOptions({ host: "mumble.example", address: "93.184.216.34", port: 1 }), {
    host: "93.184.216.34",
    port: 1,
    servername: "mumble.example",
    rejectUnauthorized: false,
    cert: undefined,
    key: undefined,
  });
  assert.equal(
    tlsOptions({ host: "93.184.216.34", address: "93.184.216.34" }).servername,
    undefined,
    "no name for an address",
  );
});

const job = (over = {}) => ({
  match: "m1",
  invite: "inv",
  host: "mumble.example",
  port: 64738,
  password: "pw",
  channel: "Team Comms",
  delay: 90,
  asked: 1,
  page: "https://stv.tf/w/m1/",
  voice: "https://stv.tf/w/m1/voice",
  ...over,
});

/**
 * A session on a made-up server, posting to a made-up stv.tf.
 * @param {Record<string, unknown>} [over] @param {Partial<import("../src/mumble/session.mjs").Options>} [options]
 */
function session(over = {}, options = {}) {
  /** @type {Server[]} */
  const servers = [];
  /** @type {{ frames: string[] }[]} */
  const posts = [];
  /** @type {string[]} */
  const statuses = [];
  /** @type {string[]} */
  const states = [];
  /** @type {string[]} */
  const logged = [];
  const s = startSession(job(over), (state, text) => void (states.push(state), statuses.push(text)), {
    key: "k",
    lookup: lookupOf(["93.184.216.34"]),
    pause: async () => {},
    print: line => void logged.push(line),
    connect: () => {
      const server = fake();
      servers.push(server);
      return server.connect();
    },
    fetch: fetchOf(
      async (url, init) => (posts.push(JSON.parse(init.body)), { ok: true, status: 200, text: async () => "ok" }),
    ),
    ...options,
  });
  return { s, servers, posts, statuses, states, logged, server: () => /** @type {Server} */ (servers.at(-1)) };
}
/** @param {Server} server @param {number} n */
const talk = (server, n) => {
  for (let i = 0; i < n; i++) server.send("UDPTunnel", Buffer.from([0x80, 9, i, 2, 0x78, i]));
};

/** A session in its channel. */
async function joined() {
  const w = session();
  await until(() => w.servers.length);
  welcomeIn(w.server());
  await until(() => w.statuses.length);
  return w;
}

test("once told to leave, nothing more is passed on", async () => {
  const w = await joined();
  talk(w.server(), 3);
  await tick();
  const left = w.s.leave("done");
  talk(w.server(), 10);
  await left;
  for (let n = 0; n < 10; n++) await tick();
  assert.equal(w.posts.flatMap(p => p.frames).length, 3);
});

test("leaving resolves once the connection is closed, joined or not yet", async () => {
  const w = await joined();
  const left = w.s.leave("done");
  assert.ok(left instanceof Promise);
  await left;
  assert.equal(w.server().closed, true);
  assert.deepEqual(
    w
      .server()
      .sent("TextMessage")
      .map(m => m.message)
      .at(-1),
    "Leaving: done",
  );

  const early = session();
  await until(() => early.servers.length);
  await early.s.leave("done");
  assert.equal(early.server().closed, true);
});

test("a name in use is taken with a letter after it", async () => {
  const w = session();
  for (let n = 1; n <= 2; n++) {
    await until(() => w.servers.length === n);
    w.server().send("Reject", { type: 5, reason: "Username already in use" });
  }
  await until(() => w.servers.length === 3);
  await until(() => w.server().sent("Authenticate").length);
  assert.deepEqual(
    w.servers.map(s => s.sent("Authenticate")[0].username),
    ["stv.tf-m1", "stv.tf-m1-b", "stv.tf-m1-c"],
  );
  welcomeIn(w.server());
  await until(() => w.statuses.length);
  assert.equal(w.statuses.at(-1), "Team Comms · 1");
  await w.s.leave("done");
});

test("told to leave while joining, it says nothing more", async () => {
  const w = session();
  await until(() => w.servers.length);
  await w.s.leave("moved");
  for (let n = 0; n < 10; n++) await tick();
  assert.deepEqual(w.statuses, []);
});

test("each match's channel has a name of its own on a server, with no space in it", () => {
  const one = {
    match: "5d4f1b22ac95fbb47505b19a2c24b994",
    host: "h",
    port: 1,
    password: "",
    channel: "c",
    delay: 0,
    invite: "i",
    voice: "",
    page: "",
  };
  assert.equal(nameOf(one), "stv.tf-5d4f1b");
  assert.equal(nameOf({ ...one, slot: 1 }), "stv.tf-5d4f1b");
  assert.equal(nameOf({ ...one, slot: 2 }), "stv.tf-5d4f1b-2");
  assert.notEqual(nameOf(one), nameOf({ ...one, match: "aaaaaa22ac95fbb47505b19a2c24b994" }));
});

test("a server on this network is joined only when the bot is told it may be", async () => {
  const here = session({}, { lookup: lookupOf(["10.0.0.1"]) });
  await until(() => here.statuses.length);
  assert.deepEqual(here.statuses, ["Could not join: private address"]);
  assert.equal(here.servers.length, 0);
  const lan = session({}, { lookup: lookupOf(["10.0.0.1"]), anywhere: true });
  await until(() => lan.servers.length);
  await lan.s.leave("done");
});

test("how it goes is logged when it changes, and the key never", async () => {
  const w = await joined();
  await w.s.leave("done");
  assert.deepEqual(
    w.logged.map(l => l.replace(/^.*→ \S+: /, "")),
    ["Team Comms · 1", "Leaving: done"],
  );
  assert.ok(
    w.logged.every(l => l.startsWith("stvtf-voice-bot: mumble:mumble.example:Team_Comms → https://stv.tf/w/m1/")),
  );
  assert.ok(!w.logged.join("\n").includes("Bearer"));
});

test("what stv.tf is told says where the bot is: in, out again, or never in", async () => {
  const w = await joined();
  w.server().send("UserRemove", { session: 2, reason: "kicked" });
  await until(() => w.states.length === 2);
  assert.deepEqual(
    w.states.map((s, n) => [s, w.statuses[n]]),
    [
      ["in", "Team Comms · 1"],
      ["left", "Left: removed: kicked"],
    ],
  );
  const never = session({}, { lookup: lookupOf(["10.0.0.1"]) });
  await until(() => never.states.length);
  assert.deepEqual(never.states, ["failed"]);
});
