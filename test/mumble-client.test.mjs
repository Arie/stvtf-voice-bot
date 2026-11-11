import assert from "node:assert/strict";
import { test } from "node:test";
import { MumbleClient, voiceId } from "../src/mumble/client.mjs";
import { fake, tick, welcome, welcomeIn } from "./fake-mumble.mjs";

test("it signs in as a bot, goes to the channel, and says it is recording", async () => {
  const server = fake();
  const client = new MumbleClient({
    host: "h",
    username: "stv.tf",
    password: "pw",
    channel: "team comms",
    connect: server.connect,
  });
  const joined = client.join();
  await tick();
  assert.deepEqual(
    server.sent("Version")[0].version_v1,
    (1 << 16) | (4 << 8),
    "of before 1.5: the server sends voice the older way",
  );
  assert.deepEqual(server.sent("Authenticate"), [{ username: "stv.tf", password: "pw", opus: true, client_type: 1 }]);
  welcomeIn(server);
  await joined;
  assert.deepEqual(server.sent("UserState"), [{ session: 2, channel_id: 5, self_mute: true, recording: true }]);
  assert.deepEqual(
    client.people().map(p => p.name),
    ["arie"],
    "those in its channel, itself aside",
  );
});

test("each speaker's Opus is handed on with who they are", async () => {
  const server = fake();
  /** @type {any[]} */
  const heard = [];
  const client = new MumbleClient({
    host: "h",
    username: "stv.tf",
    channel: "Team Comms",
    connect: server.connect,
    onVoice: v => heard.push(v),
  });
  const joined = client.join();
  await tick();
  welcomeIn(server);
  await joined;
  const opus = Buffer.from([0x78, 1, 2]);
  server.send("UDPTunnel", Buffer.from([0x80, 9, 0, 0xa0, 3, ...opus]));
  server.send("UDPTunnel", Buffer.from([0x80, 44, 0, 3, ...opus]));
  await tick();
  assert.deepEqual(
    heard,
    [{ session: 9, name: "arie", id: "cert:abc", opus, last: true }],
    "someone it knows nothing of is not passed on",
  );
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
  const client = new MumbleClient({
    host: "h",
    username: "stv.tf",
    channel: "Team Comms",
    connect: server.connect,
    onGone: why => (gone = why),
  });
  const joined = client.join();
  await tick();
  welcomeIn(server);
  await joined;
  server.send("UserRemove", { session: 2, reason: "bye" });
  await tick();
  assert.match(gone, /removed.*bye/);
});

test("it tells the channel things, and pings so the server keeps it", async () => {
  const server = fake();
  /** @type {(() => void)[]} */
  const timers = [];
  const client = new MumbleClient({
    host: "h",
    username: "stv.tf",
    channel: "Team Comms",
    connect: server.connect,
    every: f => (timers.push(f), () => {}),
  });
  const joined = client.join();
  await tick();
  welcomeIn(server);
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
  const client = new MumbleClient({
    host: "h",
    username: "stv.tf",
    channel: "Team Comms",
    connect: server.connect,
    onGone: why => (gone = why),
  });
  const joined = client.join();
  await tick();
  welcomeIn(server);
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
  const c2 = new MumbleClient({
    host: "h",
    username: "stv.tf",
    channel: "Team Comms",
    connect: other.connect,
    onGone: why => (left = why),
  });
  const j2 = c2.join();
  await tick();
  for (let i = 0; i < 6000; i++) other.send("ChannelState", { channel_id: i, name: "c" });
  await assert.rejects(j2, /too many channels/);
  assert.equal(left, "too many channels");
});

test("it is in the channel only once the server says so: a move refused, or later made elsewhere, ends it", async () => {
  const server = fake();
  const client = new MumbleClient({ host: "h", username: "stv.tf", channel: "Team Comms", connect: server.connect });
  let joined = false;
  const joining = client.join().then(() => (joined = true));
  await tick();
  welcome(server);
  await tick();
  assert.equal(joined, false, "asked to move, not moved yet");
  server.send("UserState", { session: 9, channel_id: 0 });
  await tick();
  assert.equal(joined, false, "someone else moving is not it");
  server.send("UserState", { session: 2, channel_id: 5 });
  await joining;

  const refusing = fake();
  const a = new MumbleClient({
    host: "h",
    username: "stv.tf",
    channel: "Team Comms",
    connect: refusing.connect,
  }).join();
  await tick();
  welcome(refusing);
  refusing.send("PermissionDenied", { type: 1, reason: "no" });
  await assert.rejects(a, /move refused/);

  const mover = fake();
  let gone = "";
  const b = new MumbleClient({
    host: "h",
    username: "stv.tf",
    channel: "Team Comms",
    connect: mover.connect,
    onGone: why => (gone = why),
  });
  const bj = b.join();
  await tick();
  welcomeIn(mover);
  await bj;
  mover.send("UserState", { session: 2, channel_id: 0 });
  await tick();
  assert.equal(gone, "moved");
});

test("already in the channel, it only marks itself as recording", async () => {
  const server = fake();
  const client = new MumbleClient({ host: "h", username: "stv.tf", channel: "root", connect: server.connect });
  const joined = client.join();
  await tick();
  welcome(server);
  await joined;
  assert.deepEqual(server.sent("UserState"), [{ session: 2, self_mute: true, recording: true }]);
});

test("only talk to the channel, from those in it, is handed on: no whispers, shouts or its own voice back", async () => {
  const server = fake();
  /** @type {any[]} */
  const heard = [];
  const client = new MumbleClient({
    host: "h",
    username: "stv.tf",
    channel: "Team Comms",
    connect: server.connect,
    onVoice: v => heard.push(v.session),
  });
  const joined = client.join();
  await tick();
  welcome(server);
  server.send("UDPTunnel", Buffer.from([0x80, 9, 0, 3, 0x78, 1, 2]));
  await tick();
  assert.deepEqual(heard, [], "nothing before it is in the channel");
  server.send("UserState", { session: 2, channel_id: 5 });
  await joined;
  server.send("UserState", { session: 7, name: "elsewhere", channel_id: 0 });
  for (const [type, session] of [
    [0x80, 9],
    [0x81, 9],
    [0x82, 9],
    [0x9e, 9],
    [0x9f, 9],
    [0x80, 7],
  ])
    server.send("UDPTunnel", Buffer.from([type, session, 0, 3, 0x78, 1, 2]));
  await tick();
  assert.deepEqual(heard, [9]);
});
