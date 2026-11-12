import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "../src/discord/join.mjs";
import { stand } from "./stand.mjs";

/** What the bot said, and where. @typedef {[string, { content: string; allowedMentions?: { parse: string[] } } | undefined]} Said */
/** @typedef {Parameters<typeof join>[1]} Options */
/** @typedef {import("../src/discord/join.mjs").Joined & { o: Parameters<Options["makeChannel"]>[0] }} Made */

/**
 * A made-up `/stv join`, with what the bot said, and a made-up channel to join.
 * @param {{ deferReply?: () => Promise<void>; unlinked?: () => Promise<string[]> }} [over]
 */
function world({ deferReply = async () => {}, unlinked = async () => ["arie"] } = {}) {
  /** @type {Said[]} */
  const said = [];
  /** @param {string} where */
  const to = where => async (/** @type {Said[1]} */ m) => void said.push([where, m]);
  const voice = { id: "42", type: 2, send: to("channel") };
  const i = {
    user: { id: "1", displayName: "arie" },
    guild: {
      id: "g",
      members: { fetch: async () => ({ voice: { channel: voice } }), me: { setNickname: async () => {} } },
    },
    options: { getString: () => "https://stv.tf/w/abc/?voice=0123456789abcdef", getNumber: () => null },
    reply: to("reply"),
    deferReply,
    editReply: to("edit"),
    followUp: to("follow"),
  };
  /** @type {Made | null} */
  let made = null;
  /** @type {Options} */
  const o = {
    hosts: ["stv.tf"],
    key: "k",
    nick: "stv.tf",
    defaultDelay: 90,
    channels: new Map(),
    joining: new Set(),
    whoFor: () => stand({}),
    makeChannel: c =>
      (made = {
        o: c,
        join: async () => {},
        leave: () => {},
        unlinked: () => (said.push(["asked", undefined]), unlinked()),
      }),
  };
  /** @type {import("discord.js").ChatInputCommandInteraction} */
  const interaction = stand(i);
  return { i: interaction, o, said, made: () => /** @type {Made} */ (made) };
}

test("it says it is recording before it knows who is not linked, then says that", async () => {
  /** @type {(v: string[]) => void} */
  let known = () => {};
  const w = world({ unlinked: () => new Promise(r => (known = r)) });
  const joined = join(w.i, w.o);
  await new Promise(r => setImmediate(r));
  assert.match(w.said.find(s => s[0] === "edit")?.[1]?.content ?? "", /Recording/);
  known(["arie"]);
  await joined;
  assert.match(JSON.stringify(w.said.at(-1)), /Not linked: arie/);
});

test("however a join ends, the server can be joined again", async () => {
  for (const over of [
    { deferReply: async () => Promise.reject(new Error("gone")) },
    { unlinked: async () => Promise.reject(new Error("down")) },
  ]) {
    const w = world(over);
    await join(w.i, w.o).catch(() => {});
    assert.equal(w.o.joining.size, 0);
  }
  const w = world();
  w.o.makeChannel = () => ({
    join: async () => Promise.reject(new Error("no")),
    leave: () => {},
    unlinked: async () => [],
  });
  await join(w.i, w.o);
  assert.equal(w.o.joining.size, 0);
});

test("what it says in a channel mentions nobody, whatever names are in it", async () => {
  const w = world({ unlinked: async () => ["@everyone"] });
  await join(w.i, w.o);
  w.made().o.onGone("/stv leave by @everyone");
  await new Promise(r => setImmediate(r));
  for (const kind of ["follow", "channel"])
    assert.deepEqual(w.said.find(s => s[0] === kind)?.[1]?.allowedMentions, { parse: [] }, kind);
});
