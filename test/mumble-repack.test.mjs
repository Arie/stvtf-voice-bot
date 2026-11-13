import assert from "node:assert/strict";
import { test } from "node:test";
import { Repacker20ms } from "../src/mumble/repack.mjs";
import { opusDuration } from "../src/mumble/voice.mjs";

// Packets of one frame: full band CELT of 10 ms (0xf0) and of 20 ms (0xf8), hybrid of 10 ms (0x70).
const ten = (/** @type {number[]} */ ...body) => Buffer.from([0xf0, ...body]);
const twenty = (/** @type {number[]} */ ...body) => Buffer.from([0xf8, ...body]);

test("packets of 20 ms pass as they are", () => {
  const t = new Repacker20ms();
  assert.deepEqual(t.push(twenty(1, 2, 3)), [twenty(1, 2, 3)]);
});

test("two of 10 ms become one packet of 20 ms, holding both frames as they were", () => {
  const t = new Repacker20ms();
  assert.deepEqual(t.push(ten(1, 2, 3)), [], "half of one");
  const out = t.push(ten(4, 5));
  assert.equal(out.length, 1);
  // The same kind of frame, now two of them (code 3), of varying length: 3 bytes, then the rest.
  assert.deepEqual([...out[0]], [0xf3, 0x82, 3, 1, 2, 3, 4, 5]);
  assert.equal(opusDuration(out[0]), 20);
});

test("a frame of 300 bytes has its length in two bytes", () => {
  const t = new Repacker20ms();
  const big = Buffer.alloc(300, 7);
  t.push(Buffer.concat([Buffer.from([0xf0]), big]));
  const out = t.push(ten(9))[0];
  assert.deepEqual([...out.subarray(0, 4)], [0xf3, 0x82, 252, 12], "252 + 4 x 12 = 300");
  assert.equal(out.length, 4 + 300 + 1);
});

test("the end of an utterance, or another kind of frame, sends what is left on its own", () => {
  const t = new Repacker20ms();
  t.push(ten(1));
  assert.deepEqual(t.push(Buffer.from([0x70, 2])), [ten(1)], "another kind: not put together");
  assert.deepEqual(t.flush(), [Buffer.from([0x70, 2])]);
  assert.deepEqual(t.flush(), []);
});

test("a packet of two frames of 20 ms comes apart, and one of four of 5 ms stays whole", () => {
  const t = new Repacker20ms();
  // Code 1: two frames of equal length.
  assert.deepEqual(t.push(Buffer.from([0xf9, 1, 2, 3, 4])), [twenty(1, 2), twenty(3, 4)]);
  // Code 3, four frames of 5 ms (0xe8 is CELT full band 5 ms), constant length 1.
  const four = Buffer.from([0xeb, 0x04, 1, 2, 3, 4]);
  const out = t.push(four);
  assert.equal(out.length, 1);
  assert.equal(opusDuration(out[0]), 20);
});
