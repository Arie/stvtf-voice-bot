import assert from "node:assert/strict";
import { test } from "node:test";
import { tlsOptions } from "../src/mumble/client.mjs";
import { addressOf, startSession } from "../src/mumble/session.mjs";
import { fake, tick, welcomeIn } from "./fake-mumble.mjs";

const lookup = (/** @type {string[]} */ ips) => async (host, o) => (assert.equal(o.all, true), ips.map(address => ({ address, family: address.includes(":") ? 6 : 4 })));

test("a server is joined at an address checked, every one of its addresses public", async () => {
  assert.equal(await addressOf("mumble.example", { lookup: lookup(["93.184.216.34", "2606:2800:220:1::1"]) }), "93.184.216.34");
  await assert.rejects(addressOf("mumble.example", { lookup: lookup(["93.184.216.34", "10.0.0.1"]) }), /private address/);
  await assert.rejects(addressOf("mumble.example", { lookup: lookup(["::1", "93.184.216.34"]) }), /private address/);
  await assert.rejects(addressOf("mumble.example", { lookup: lookup([]) }), /no address/);
  assert.equal(await addressOf("mumble.example", { lookup: lookup(["10.0.0.1"]), anywhere: true }), "10.0.0.1", "when said so, for trying out");
});

test("the connection goes to that address, its name the server's for TLS", () => {
  assert.deepEqual(tlsOptions({ host: "mumble.example", address: "93.184.216.34", port: 1 }), {
    host: "93.184.216.34", port: 1, servername: "mumble.example", rejectUnauthorized: false, cert: undefined, key: undefined,
  });
  assert.equal(tlsOptions({ host: "93.184.216.34", address: "93.184.216.34" }).servername, undefined, "no name for an address");
});

const job = (over = {}) => ({
  match: "m1", invite: "inv", host: "mumble.example", port: 64738, password: "pw", channel: "Team Comms", delay: 90, asked: 1,
  page: "https://stv.tf/w/m1/", voice: "https://stv.tf/w/m1/voice", ...over,
});

/** A session on a made-up server, posting to a made-up stv.tf. */
function session(over = {}) {
  const servers = [];
  const posts = [];
  const statuses = [];
  const s = startSession(job(over), (text, people) => statuses.push(text), {
    key: "k",
    lookup: lookup(["93.184.216.34"]),
    connect: () => (servers.push(fake()), servers.at(-1).connect()),
    fetch: async (url, init) => (posts.push(JSON.parse(init.body)), { ok: true, status: 200, text: async () => "ok" }),
  });
  return { s, servers, posts, statuses, server: () => servers.at(-1) };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
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
