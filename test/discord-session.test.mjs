import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { DiscordSession } from "../src/discord/session.mjs";
import { fetchOf, stand, tick, until } from "./stand.mjs";

/** A made-up Discord voice channel, its server, and the bot's voice connection to it. */
function world() {
  const member = (/** @type {string} */ id, /** @type {string} */ name, bot = false) => ({
    id,
    displayName: name,
    user: { bot },
  });
  const members = new Map([
    ["1", member("1", "arie")],
    ["bot", member("bot", "stv.tf", true)],
  ]);
  const guild = { id: "g", name: "G", voiceAdapterCreator: {}, members: { cache: members, me: members.get("bot") } };
  const channel = { id: "42", name: "General", type: 2, guild, members };
  /** @type {Map<string, EventEmitter>} Each speaker's Opus, as Discord sends it. */
  const streams = new Map();
  const connection = Object.assign(new EventEmitter(), {
    receiver: {
      speaking: new EventEmitter(),
      subscribe: (/** @type {string} */ id) => streams.set(id, new EventEmitter()).get(id),
    },
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  });
  /** @type {{ status?: string; channel?: string; frames?: string[]; left?: boolean }[]} */
  const told = [];
  const fetch = fetchOf(
    async (url, init) => (told.push(JSON.parse(init.body)), { ok: true, status: 204, text: async () => "" }),
  );
  /** @type {string[]} */
  const gone = [];
  const c = new DiscordSession({
    channel: stand(channel),
    match: { voice: "https://stv.tf/w/m/voice", page: "https://stv.tf/w/m/", invite: "inv" },
    delay: 90,
    key: "k",
    who: { peek: () => null, lookup: async () => null },
    onGone: why => void gone.push(why),
    fetch,
    voice: { joinVoiceChannel: stand(() => connection), entersState: stand(async () => {}) },
  });
  return { c, channel, members, member, connection, streams, told, gone };
}

test("a voice connection's error leaves that channel, and nothing else", async () => {
  const w = world();
  await w.c.join();
  try {
    w.connection.emit("error", new Error("udp"));
  } finally {
    w.c.leave("x");
  }
  assert.deepEqual(w.gone, ["voice error"]);
  assert.equal(w.connection.destroyed, true);
});

test("what stv.tf is told says which channel it is of", async () => {
  const w = world();
  await w.c.join();
  w.c.leave("done");
  await tick();
  assert.deepEqual(
    w.told.map(t => [t.status ?? "left", t.channel]),
    [
      ["General · 1", "42"],
      ["left", "42"],
    ],
  );
});

test("dragged to another channel, it leaves rather than record there", async () => {
  const w = world();
  await w.c.join();
  w.c.update({ id: "bot", channelId: "42" }, { id: "bot", channelId: "42" });
  assert.deepEqual(w.gone, []);
  w.c.update({ id: "bot", channelId: "42" }, { id: "bot", channelId: "43" });
  assert.deepEqual(w.gone, ["moved"]);
});

test("stv.tf is told who is here when that changes, not when anyone on the server mutes", async () => {
  const w = world();
  await w.c.join();
  await tick();
  const before = w.told.length;
  w.c.update({ id: "1", channelId: "42" }, { id: "1", channelId: "42" });
  w.c.update({ id: "7", channelId: "50" }, { id: "7", channelId: "51" });
  w.c.update({ id: "7", channelId: null }, { id: "7", channelId: "50" });
  await tick();
  assert.equal(w.told.length, before);
  w.members.set("7", w.member("7", "coach"));
  w.c.update({ id: "7", channelId: "50" }, { id: "7", channelId: "42" });
  await tick();
  assert.equal(w.told.at(-1)?.status, "General · 2");
  w.c.leave("done");
});

test("leaving, it posts what was said up to then", async () => {
  const w = world();
  await w.c.join();
  w.connection.receiver.speaking.emit("start", "1");
  for (let i = 0; i < 2; i++) w.streams.get("1")?.emit("data", Buffer.from([i]));
  await tick();
  w.c.leave("done");
  await until(() => w.told.some(t => t.frames));
  assert.deepEqual(w.told.find(t => t.frames)?.frames?.length, 2);
});

test("a connection lost a moment is waited for; one that does not come back is left", async () => {
  /** @type {string[]} */
  const waited = [];
  for (const back of [true, false]) {
    const w = world();
    w.c.voice.entersState = stand(async (/** @type {unknown} */ c, /** @type {string} */ state) => {
      waited.push(state);
      if (state !== "ready" && !back) throw new Error("timed out");
    });
    await w.c.join();
    w.connection.emit("disconnected");
    await tick();
    assert.deepEqual(w.gone, back ? [] : ["disconnected"], `back: ${back}`);
    w.c.leave("done");
  }
  assert.deepEqual(waited.slice(0, 3), ["ready", "signalling", "connecting"]);
});

test("leaving resolves once its goodbyes are out, not before", async () => {
  const w = world();
  await w.c.join();
  /** @type {() => void} */
  let said = () => {};
  w.c.o.onGone = () => new Promise(r => (said = () => r(undefined)));
  let left = false;
  const leaving = w.c.leave("restarting").then(() => (left = true));
  for (let n = 0; n < 5; n++) await tick();
  assert.equal(left, false, "the channel not told yet");
  said();
  await leaving;
  assert.equal(w.c.leave("again"), w.c.leave("again"), "once");
  assert.ok(w.told.some(t => t.left));
});
