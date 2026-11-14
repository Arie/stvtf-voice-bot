import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { joinCommand, rejoin } from "../src/discord/join.mjs";
import { Kept } from "../src/discord/kept.mjs";
import { stand, tick } from "./stand.mjs";

/** What the bot said, and where. @typedef {[string, { content: string; allowedMentions?: { parse: string[] } } | undefined]} Said */
/** @typedef {Parameters<typeof joinCommand>[1]} Options */
/** @typedef {import("../src/discord/join.mjs").Joined & { o: Parameters<Options["makeSession"]>[0] }} Made */

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
    sessions: new Map(),
    joining: new Set(),
    kept: new Kept(null),
    whoFor: () => stand({}),
    makeSession: c =>
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
  const joined = joinCommand(w.i, w.o);
  await tick();
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
    await joinCommand(w.i, w.o).catch(() => {});
    assert.equal(w.o.joining.size, 0);
  }
  const w = world();
  w.o.makeSession = () => ({
    join: async () => Promise.reject(new Error("no")),
    leave: () => {},
    unlinked: async () => [],
  });
  await joinCommand(w.i, w.o);
  assert.equal(w.o.joining.size, 0);
});

test("what it says in a channel mentions nobody, whatever names are in it", async () => {
  const w = world({ unlinked: async () => ["@everyone"] });
  await joinCommand(w.i, w.o);
  w.made().o.onGone("/stv leave by @everyone");
  await tick();
  for (const kind of ["follow", "channel"])
    assert.deepEqual(w.said.find(s => s[0] === kind)?.[1]?.allowedMentions, { parse: [] }, kind);
});

test("a join that fails says nothing of leaving a channel it was never in", async () => {
  const w = world();
  w.o.makeSession = c => ({
    join: async () => Promise.reject(new Error("no")),
    leave: why => c.onGone(why),
    unlinked: async () => [],
  });
  await joinCommand(w.i, w.o);
  assert.deepEqual(
    w.said.map(s => s[0]),
    ["edit"],
  );
});

const KEPT = { guild: "g", channel: "42", link: "https://stv.tf/w/abc/?voice=0123456789abcdef", delay: 90 };

test("a channel it is in is kept until it leaves for good, not when it only stops", async () => {
  const w = world();
  w.o.kept = new Kept(join(mkdtempSync(join(tmpdir(), "stvtf-kept-")), "discord.json"));
  await joinCommand(w.i, w.o);
  assert.deepEqual(w.o.kept.list(), [KEPT]);
  w.o.kept.stopping = true;
  w.made().o.onGone("restarting");
  await tick();
  assert.deepEqual(w.o.kept.list(), [KEPT], "it goes back in");
  assert.equal(w.said.filter(s => s[0] === "channel").length, 0, "and says nothing of leaving");

  const again = world();
  await joinCommand(again.i, again.o);
  again.made().o.onGone("match ended");
  await tick();
  assert.deepEqual(again.o.kept.list(), []);
  assert.match(again.said.find(s => s[0] === "channel")?.[1]?.content ?? "", /Left: match ended/);
});

test("started again, it goes back into the channels kept, saying nothing", async () => {
  const w = world();
  const voice = { id: "42", type: 2, isVoiceBased: () => true, send: async () => assert.fail("it said something") };
  const guild = { id: "g", members: { me: { setNickname: async () => {} } }, channels: { fetch: async () => voice } };
  /** @type {import("discord.js").Client} */
  const client = stand({
    guilds: { fetch: async (/** @type {string} */ id) => (id === "g" ? guild : Promise.reject(new Error("gone"))) },
  });
  w.o.kept.add(KEPT);
  w.o.kept.add({ ...KEPT, guild: "left" });
  for (const kept of w.o.kept.list()) await rejoin(client, w.o, kept);
  assert.deepEqual([...w.o.sessions.keys()], ["g"]);
  assert.equal(w.made().o.delay, 90);
  assert.deepEqual(w.o.kept.list(), [KEPT], "a server it is no longer in is forgotten");
});

test("the channels kept are in a file, read when it starts", () => {
  const path = join(mkdtempSync(join(tmpdir(), "stvtf-kept-")), "discord.json");
  const kept = new Kept(path);
  kept.add(KEPT);
  kept.setDelay("g", 30);
  assert.deepEqual(new Kept(path).list(), [{ ...KEPT, delay: 30 }]);
  kept.forget("g");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), []);
  writeFileSync(path, "not json");
  assert.deepEqual(new Kept(path).list(), [], "a file that does not read keeps none");
});

test("stopped with nowhere to keep its channels, it says it left, as it will not be back", async () => {
  const w = world();
  await joinCommand(w.i, w.o);
  w.o.kept.stopping = true;
  w.made().o.onGone("restarting");
  await tick();
  assert.match(w.said.find(s => s[0] === "channel")?.[1]?.content ?? "", /Left: restarting/);
});

test("back in a channel everyone left meanwhile, it leaves", async () => {
  const w = world();
  const voice = { id: "42", type: 2, isVoiceBased: () => true, send: async () => {} };
  const guild = { id: "g", members: { me: { setNickname: async () => {} } }, channels: { fetch: async () => voice } };
  /** @type {import("discord.js").Client} */
  const client = stand({ guilds: { fetch: async () => guild } });
  /** @type {string[]} */
  const left = [];
  w.o.makeSession = () => ({
    join: async () => {},
    leave: why => void left.push(why),
    unlinked: async () => [],
    hasPeople: () => false,
  });
  await rejoin(client, w.o, KEPT);
  assert.deepEqual(left, ["channel empty"]);
});
