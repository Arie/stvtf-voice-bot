import assert from "node:assert/strict";
import { test } from "node:test";
import { decode, encode, frame, Frames, TYPES } from "../src/mumble/proto.mjs";
import { opusDuration, parseVoice, varint } from "../src/mumble/voice.mjs";

test("messages are written and read back as Mumble has them", () => {
  const auth = encode("Authenticate", { username: "stv.tf", password: "pw", opus: true, client_type: 1 });
  assert.deepEqual(decode("Authenticate", auth), { username: "stv.tf", password: "pw", opus: true, client_type: 1 });
  // Field 1, a string of 6: as any protobuf writer has it.
  assert.deepEqual([...auth.subarray(0, 8)], [0x0a, 6, ...Buffer.from("stv.tf")]);
  const state = decode(
    "UserState",
    encode("UserState", { session: 300, name: "Ärie", channel_id: 5, self_mute: true, recording: true }),
  );
  assert.deepEqual(state, { session: 300, name: "Ärie", channel_id: 5, self_mute: true, recording: true });
  assert.deepEqual(decode("TextMessage", encode("TextMessage", { channel_id: [5, 6], message: "hi" })), {
    channel_id: [5, 6],
    message: "hi",
  });
  // What we know nothing of is passed over.
  assert.deepEqual(decode("Ping", Buffer.concat([encode("Ping", { timestamp: 7 }), Buffer.from([0xf8, 0x07, 0x01])])), {
    timestamp: 7,
  });
});

test("the connection is cut into messages: a type, a length, the rest, however it arrives", () => {
  const a = frame("Ping", encode("Ping", { timestamp: 1 }));
  const b = frame("UDPTunnel", Buffer.from([1, 2, 3]));
  assert.deepEqual([a.readUInt16BE(0), a.readUInt32BE(2)], [TYPES.Ping, 2]);
  const frames = new Frames();
  const all = Buffer.concat([a, b]);
  const got = [...frames.push(all.subarray(0, 3)), ...frames.push(all.subarray(3, 9)), ...frames.push(all.subarray(9))];
  assert.deepEqual(
    got.map(m => [m.type, [...m.body]]),
    [
      ["Ping", [8, 1]],
      ["UDPTunnel", [1, 2, 3]],
    ],
  );
});

test("numbers in voice packets are Mumble's own, of one to nine bytes", () => {
  assert.deepEqual(varint(Buffer.from([0x7f]), 0), [0x7f, 1]);
  assert.deepEqual(varint(Buffer.from([0x81, 0x02]), 0), [0x102, 2]);
  assert.deepEqual(varint(Buffer.from([0xc1, 0x02, 0x03]), 0), [0x10203, 3]);
  assert.deepEqual(varint(Buffer.from([0xe1, 0x02, 0x03, 0x04]), 0), [0x1020304, 4]);
  assert.deepEqual(varint(Buffer.from([0xf0, 0x01, 0x02, 0x03, 0x04]), 0), [0x1020304, 5]);
});

test("a voice packet says who talks, and holds one Opus packet and whether the utterance ends", () => {
  // Opus (type 4), to everyone; session 300; sequence 9; five bytes of Opus, the last of an utterance.
  const opus = Buffer.from([0x78, 1, 2, 3, 4]);
  const packet = Buffer.from([0x80, 0x81, 0x2c, 9, 0xa0, 5, ...opus, 0, 0, 0, 0]);
  assert.deepEqual(parseVoice(packet), { target: 0, session: 300, sequence: 9, opus, last: true });
  assert.equal(parseVoice(Buffer.from([0x80, 0x81, 0x2c, 9, 5, ...opus]))?.last, false);
  assert.equal(parseVoice(Buffer.from([0x82, 0x81, 0x2c, 9, 5, ...opus]))?.target, 2, "a whisper");
  assert.equal(parseVoice(Buffer.from([0x20, 1, 2])), null, "a ping, or another codec: not voice of ours");
  assert.equal(parseVoice(Buffer.from([0x80, 1, 9, 50, 1])), null, "cut short");
});

test("an Opus packet says how long it is", () => {
  assert.equal(opusDuration(Buffer.from([0x78, 0])), 20, "full band, one frame of 20 ms");
  assert.equal(opusDuration(Buffer.from([0x70, 0])), 10);
  assert.equal(opusDuration(Buffer.from([0x79, 0])), 40, "two frames of 20");
  assert.equal(opusDuration(Buffer.from([0x7b, 3, 0])), 60, "three frames of 20");
  assert.equal(opusDuration(Buffer.from([0x08, 0])), 20, "SILK narrow band, 20 ms");
  assert.equal(opusDuration(Buffer.from([0x18, 0])), 60);
  assert.equal(opusDuration(Buffer.alloc(0)), 0);
});

test("a number of more than ten bytes is a broken message, not a long wait", () => {
  assert.throws(() => decode("Ping", Buffer.from([0x08, ...Array(10).fill(0xff), 0x01])), /too long/);
  assert.deepEqual(decode("Ping", Buffer.from([0x08, ...Array(9).fill(0xff), 0x01])), { timestamp: 2 ** 64 - 1 });
});

test("a message of more than a server needs ends it; one coming a byte at a time takes no longer than at once", () => {
  const head = Buffer.alloc(6);
  head.writeUInt32BE((1 << 20) + 1, 2);
  assert.throws(() => new Frames().push(head), /bytes/);
  const big = frame("UDPTunnel", Buffer.alloc(200_000, 7));
  const frames = new Frames();
  const started = performance.now();
  const got = [];
  for (let i = 0; i < big.length; i++) got.push(...frames.push(big.subarray(i, i + 1)));
  assert.ok(performance.now() - started < 1000, `${performance.now() - started} ms`);
  assert.deepEqual(
    got.map(m => m.body.length),
    [200_000],
  );
});
