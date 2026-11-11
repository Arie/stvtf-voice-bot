import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "../src/join.mjs";

/** A made-up `/stv join`, with what the bot said, and a made-up channel to join. */
function world({ deferReply = async () => {}, unlinked = async () => ["arie"] } = {}) {
  const said = [];
  const voice = { id: "42", type: 2, send: async m => (said.push(["channel", m]), {}) };
  const i = {
    user: { id: "1", displayName: "arie" },
    guild: { id: "g", members: { fetch: async () => ({ voice: { channel: voice } }), me: { setNickname: async () => {} } } },
    options: { getString: () => "https://stv.tf/w/abc/?voice=0123456789abcdef", getNumber: () => null },
    reply: async m => said.push(["reply", m]),
    deferReply,
    editReply: async m => said.push(["edit", m]),
    followUp: async m => said.push(["follow", m]),
  };
  /** @type {any} */
  let made = null;
  const o = {
    hosts: ["stv.tf"], key: "k", nick: "stv.tf", defaultDelay: 90,
    channels: new Map(), joining: new Set(), whoFor: () => ({}),
    makeChannel: c => (made = { o: c, join: async () => {}, leave: () => {}, unlinked: () => (said.push(["asked"]), unlinked()) }),
  };
  return { i, o, said, made: () => made };
}

test("it says it is recording before it knows who is not linked, then says that", async () => {
  /** @type {(v: string[]) => void} */
  let known = () => {};
  const w = world({ unlinked: () => new Promise(r => (known = r)) });
  const joined = join(w.i, w.o);
  await new Promise(r => setImmediate(r));
  assert.match(w.said.find(s => s[0] === "edit")?.[1].content ?? "", /Recording/);
  known(["arie"]);
  await joined;
  assert.match(JSON.stringify(w.said.at(-1)), /Not linked: arie/);
});

test("however a join ends, the server can be joined again", async () => {
  for (const over of [{ deferReply: async () => Promise.reject(new Error("gone")) }, { unlinked: async () => Promise.reject(new Error("down")) }]) {
    const w = world(over);
    await join(w.i, w.o).catch(() => {});
    assert.equal(w.o.joining.size, 0);
  }
  const w = world();
  w.o.makeChannel = () => ({ join: async () => Promise.reject(new Error("no")), leave: () => {}, unlinked: async () => [] });
  await join(w.i, w.o);
  assert.equal(w.o.joining.size, 0);
});

test("what it says in a channel mentions nobody, whatever names are in it", async () => {
  const w = world({ unlinked: async () => ["@everyone"] });
  await join(w.i, w.o);
  w.made().o.onGone("/stv leave by @everyone");
  await new Promise(r => setImmediate(r));
  for (const kind of ["follow", "channel"]) assert.deepEqual(w.said.find(s => s[0] === kind)?.[1].allowedMentions, { parse: [] }, kind);
});
