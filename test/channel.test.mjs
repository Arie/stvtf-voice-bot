import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Channel } from "../src/channel.mjs";

/** A made-up Discord voice channel, its server, and the bot's voice connection to it. */
function world() {
  const member = (id, name, bot = false) => ({ id, displayName: name, user: { bot } });
  const members = new Map([["1", member("1", "arie")], ["bot", member("bot", "stv.tf", true)]]);
  const guild = { id: "g", name: "G", voiceAdapterCreator: {}, members: { cache: members, me: members.get("bot") } };
  const channel = { id: "42", name: "General", type: 2, guild, members };
  const connection = Object.assign(new EventEmitter(), {
    receiver: { speaking: new EventEmitter(), subscribe: () => new EventEmitter() },
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  });
  const told = [];
  const fetch = async (url, init) => (told.push(JSON.parse(init.body)), { ok: true, status: 204, text: async () => "" });
  const gone = [];
  const c = new Channel({
    channel,
    match: { voice: "https://stv.tf/w/m/voice", page: "https://stv.tf/w/m/", invite: "inv" },
    delay: 90,
    key: "k",
    who: { peek: () => null, steamid: async () => null },
    onGone: why => gone.push(why),
    fetch,
    voice: { joinVoiceChannel: () => connection, entersState: async () => {} },
  });
  return { c, channel, members, member, connection, told, gone };
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
  await new Promise(r => setImmediate(r));
  assert.deepEqual(w.told.map(t => [t.status ?? "left", t.channel]), [["General · 1", "42"], ["left", "42"]]);
});

test("dragged to another channel, it leaves rather than record there", async () => {
  const w = world();
  await w.c.join();
  w.c.update({ id: "bot", channelId: "42" }, { id: "bot", channelId: "42" });
  assert.deepEqual(w.gone, []);
  w.c.update({ id: "bot", channelId: "42" }, { id: "bot", channelId: "43" });
  assert.deepEqual(w.gone, ["moved"]);
});
