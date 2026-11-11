import assert from "node:assert/strict";
import { PassThrough, Duplex } from "node:stream";
import { test } from "node:test";
import { MumbleClient, voiceId } from "../src/mumble/client.mjs";
import { decode, encode, frame, Frames } from "../src/mumble/proto.mjs";

/** A made-up server: what the client sent it, and a way to send the client messages. */
function fake() {
  const [toServer, toClient] = [new PassThrough(), new PassThrough()];
  const frames = new Frames();
  /** @type {{ type: string; body: Buffer }[]} */
  const got = [];
  toServer.on("data", d => got.push(...frames.push(d)));
  return {
    got,
    connect: () => Duplex.from({ writable: toServer, readable: toClient }),
    send: (type, message) => toClient.write(frame(type, Buffer.isBuffer(message) ? message : encode(type, message))),
    sent: type => got.filter(m => m.type === type).map(m => decode(type, m.body)),
    end: () => toClient.end(),
  };
}
const tick = () => new Promise(r => setImmediate(r));

/** The server lets the client in: two channels, someone in one of them, and the client itself. */
function welcome(server) {
  server.send("ChannelState", { channel_id: 0, name: "Root" });
  server.send("ChannelState", { channel_id: 5, parent: 0, name: "Team Comms" });
  server.send("UserState", { session: 9, name: "arie", channel_id: 5, hash: "abc" });
  server.send("UserState", { session: 2, name: "stv.tf", channel_id: 0 });
  server.send("ServerSync", { session: 2, welcome_text: "hi" });
}

test("it signs in as a bot, goes to the channel, and says it is recording", async () => {
  const server = fake();
  const client = new MumbleClient({ host: "h", username: "stv.tf", password: "pw", channel: "team comms", connect: server.connect });
  const joined = client.join();
  await tick();
  assert.deepEqual(server.sent("Version")[0].version_v1, (1 << 16) | (4 << 8), "of before 1.5: the server sends voice the older way");
  assert.deepEqual(server.sent("Authenticate"), [{ username: "stv.tf", password: "pw", opus: true, client_type: 1 }]);
  welcome(server);
  await joined;
  assert.deepEqual(server.sent("UserState"), [{ session: 2, channel_id: 5, self_mute: true, recording: true }]);
  assert.deepEqual(client.people().map(p => p.name), ["arie"], "those in its channel, itself aside");
});

test("each speaker's Opus is handed on with who they are", async () => {
  const server = fake();
  /** @type {any[]} */
  const heard = [];
  const client = new MumbleClient({ host: "h", username: "stv.tf", channel: "Team Comms", connect: server.connect, onVoice: v => heard.push(v) });
  const joined = client.join();
  await tick();
  welcome(server);
  await joined;
  const opus = Buffer.from([0x78, 1, 2]);
  server.send("UDPTunnel", Buffer.from([0x80, 9, 0, 0xa0, 3, ...opus]));
  server.send("UDPTunnel", Buffer.from([0x80, 44, 0, 3, ...opus]));
  await tick();
  assert.deepEqual(heard, [{ session: 9, name: "arie", id: "cert:abc", opus, last: true }], "someone it knows nothing of is not passed on");
});

test("a server that refuses, a channel that is not there, and a connection lost are said", async () => {
  const refused = fake();
  const a = new MumbleClient({ host: "h", username: "stv.tf", channel: "x", connect: refused.connect }).join();
  await tick();
  refused.send("Reject", { type: 4, reason: "Wrong server password" });
  await assert.rejects(a, /Wrong server password/);

  const nowhere = fake();
  const b = new MumbleClient({ host: "h", username: "stv.tf", channel: "Elsewhere", connect: nowhere.connect }).join();
  await tick();
  welcome(nowhere);
  await assert.rejects(b, /no channel "Elsewhere"/);

  const server = fake();
  let gone = "";
  const client = new MumbleClient({ host: "h", username: "stv.tf", channel: "Team Comms", connect: server.connect, onGone: why => (gone = why) });
  const joined = client.join();
  await tick();
  welcome(server);
  await joined;
  server.send("UserRemove", { session: 2, reason: "bye" });
  await tick();
  assert.match(gone, /removed.*bye/);
});

test("it tells the channel things, and pings so the server keeps it", async () => {
  const server = fake();
  /** @type {(() => void)[]} */
  const timers = [];
  const client = new MumbleClient({ host: "h", username: "stv.tf", channel: "Team Comms", connect: server.connect, every: f => (timers.push(f), () => {}) });
  const joined = client.join();
  await tick();
  welcome(server);
  await joined;
  client.say("recording");
  timers.forEach(f => f());
  await tick();
  assert.deepEqual(server.sent("TextMessage"), [{ channel_id: [5], message: "recording" }]);
  assert.equal(server.sent("Ping").length, 1);
});

test("someone is their certificate wherever they talk, else who they are on that server", () => {
  assert.equal(voiceId("mumble.example", { id: "cert:AB12", session: 4 }), "mumble:cert:AB12");
  assert.equal(voiceId("mumble.example", { id: "user:7", session: 4 }), "mumble:mumble.example:user:7");
  assert.equal(voiceId("mumble.example", { id: "", session: 4 }), "mumble:mumble.example:session:4");
});

test("names are kept short, and a server of more people or channels than any has is left", async () => {
  const server = fake();
  let gone = "";
  const client = new MumbleClient({ host: "h", username: "stv.tf", channel: "Team Comms", connect: server.connect, onGone: why => (gone = why) });
  const joined = client.join();
  await tick();
  welcome(server);
  await joined;
  server.send("UserState", { session: 10, name: "x".repeat(10_000), channel_id: 5 });
  server.send("ChannelState", { channel_id: 6, name: "y".repeat(10_000) });
  await tick();
  assert.equal(client.users.get(10)?.name.length, 128);
  assert.equal(client.channels.get(6)?.length, 128);
  for (let s = 100; s < 20_100 && !gone; s += 1000) {
    for (let i = s; i < s + 1000; i++) server.send("UserState", { session: i, name: "u" });
    await tick();
  }
  assert.equal(gone, "too many users");
  assert.ok(client.users.size <= 5000);

  const other = fake();
  let left = "";
  const c2 = new MumbleClient({ host: "h", username: "stv.tf", channel: "Team Comms", connect: other.connect, onGone: why => (left = why) });
  const j2 = c2.join();
  await tick();
  for (let i = 0; i < 6000; i++) other.send("ChannelState", { channel_id: i, name: "c" });
  await assert.rejects(j2, /too many channels/);
  assert.equal(left, "too many channels");
});
