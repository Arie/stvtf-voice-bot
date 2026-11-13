import assert from "node:assert/strict";
import { test } from "node:test";
import { tlsOptions } from "../src/mumble/client.mjs";
import { addressOf, nameOf, startSession } from "../src/mumble/session.mjs";
import { fake, tick, welcomeIn } from "./fake-mumble.mjs";
import { fetchOf } from "./stand.mjs";

/** @typedef {import("./fake-mumble.mjs").Server} Server */

/** @param {string[]} ips @returns {import("../src/mumble/session.mjs").Lookup} */
const lookup = ips => async (host, o) => (
  assert.equal(o.all, true),
  ips.map(address => ({ address, family: address.includes(":") ? 6 : 4 }))
);

test("a server is joined at an address checked, every one of its addresses public", async () => {
  assert.equal(
    await addressOf("mumble.example", { lookup: lookup(["93.184.216.34", "2606:2800:220:1::1"]) }),
    "93.184.216.34",
  );
  await assert.rejects(
    addressOf("mumble.example", { lookup: lookup(["93.184.216.34", "10.0.0.1"]) }),
    /private address/,
  );
  await assert.rejects(addressOf("mumble.example", { lookup: lookup(["::1", "93.184.216.34"]) }), /private address/);
  await assert.rejects(addressOf("mumble.example", { lookup: lookup([]) }), /no address/);
  assert.equal(
    await addressOf("mumble.example", { lookup: lookup(["10.0.0.1"]), anywhere: true }),
    "10.0.0.1",
    "when said so, for trying out",
  );
});

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

/** A session on a made-up server, posting to a made-up stv.tf. @param {Record<string, unknown>} [over] */
function session(over = {}) {
  /** @type {Server[]} */
  const servers = [];
  /** @type {{ frames: string[] }[]} */
  const posts = [];
  /** @type {string[]} */
  const statuses = [];
  const s = startSession(job(over), text => void statuses.push(text), {
    key: "k",
    lookup: lookup(["93.184.216.34"]),
    connect: () => {
      const server = fake();
      servers.push(server);
      return server.connect();
    },
    fetch: fetchOf(
      async (url, init) => (posts.push(JSON.parse(init.body)), { ok: true, status: 200, text: async () => "ok" }),
    ),
  });
  return { s, servers, posts, statuses, server: () => /** @type {Server} */ (servers.at(-1)) };
}
const wait = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
/** @param {Server} server @param {number} n */
const talk = (server, n) => {
  for (let i = 0; i < n; i++) server.send("UDPTunnel", Buffer.from([0x80, 9, i, 2, 0x78, i]));
};

test("once told to leave, nothing more is passed on", async () => {
  const w = session();
  await wait(5);
  welcomeIn(w.server());
  await wait(5);
  talk(w.server(), 3);
  await tick();
  w.s.leave("done");
  talk(w.server(), 10);
  await wait(300);
  assert.equal(w.posts.flatMap(p => p.frames).length, 3);
});

test("leaving resolves once the connection is closed, joined or not yet", async () => {
  const w = session();
  await wait(5);
  welcomeIn(w.server());
  await wait(5);
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
  await wait(5);
  await early.s.leave("done");
  assert.equal(early.server().closed, true);
});

test("a name in use is taken with a number", async () => {
  const w = session();
  for (let n = 1; n <= 2; n++) {
    await wait(5);
    w.server().send("Reject", { type: 5, reason: "Username already in use" });
  }
  await wait(5);
  assert.deepEqual(
    w.servers.map(s => s.sent("Authenticate")[0].username),
    ["stv.tf-m1", "stv.tf-m1-b", "stv.tf-m1-c"],
  );
  welcomeIn(w.server());
  await wait(5);
  assert.equal(w.statuses.at(-1), "Team Comms · 1");
  await w.s.leave("done");
});

test("told to leave while joining, it says nothing more", async () => {
  const w = session();
  await wait(5);
  await w.s.leave("moved");
  await wait(5);
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
