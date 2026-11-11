// Mumble's users choose how much sound a packet of theirs holds (10 to 60 ms); stv.tf takes
// voice 20 ms at a time. Opus packets are frames with a byte before them that says what kind,
// so frames are regrouped as they are, with no decoding: two of 10 ms become one packet of 20,
// a packet of two of 20 ms comes apart. Only a single frame longer than 20 ms cannot be cut,
// and passes whole.
import { frameMs } from "./voice.mjs";

/** A frame's length where a packet says it. @returns {[number, number] | null} It, and where it ends. */
function readLength(/** @type {Buffer} */ b, /** @type {number} */ at) {
  if (at >= b.length) return null;
  if (b[at] < 252) return [b[at], at + 1];
  return at + 1 < b.length ? [b[at + 1] * 4 + b[at], at + 2] : null;
}

/** @param {number} n */
const writeLength = n => (n < 252 ? [n] : [252 + (n & 3), (n - (252 + (n & 3))) / 4]);

/** The frames of an Opus packet; none for one that is malformed. @param {Buffer} p @returns {Buffer[]} */
export function framesOf(p) {
  if (!p.length) return [];
  const code = p[0] & 3;
  if (code === 0) return [p.subarray(1)];
  if (code === 1) {
    const half = (p.length - 1) / 2;
    return Number.isInteger(half) ? [p.subarray(1, 1 + half), p.subarray(1 + half)] : [];
  }
  if (code === 2) {
    const first = readLength(p, 1);
    return !first || first[1] + first[0] > p.length
      ? []
      : [p.subarray(first[1], first[1] + first[0]), p.subarray(first[1] + first[0])];
  }
  return manyOf(p);
}

/** The frames of a packet of any number of them (code 3). @param {Buffer} p @returns {Buffer[]} */
function manyOf(p) {
  if (p.length < 2) return [];
  const [vbr, padded, count] = [(p[1] & 0x80) !== 0, (p[1] & 0x40) !== 0, p[1] & 0x3f];
  const pad = padded ? paddingOf(p) : { at: 2, pad: 0 };
  if (!pad) return [];
  let at = pad.at;
  const end = p.length - pad.pad;
  if (!count || end < at) return [];
  const lengths = [];
  if (vbr) {
    for (let i = 0; i < count - 1; i++) {
      const l = readLength(p, at);
      if (!l) return [];
      lengths.push(l[0]);
      at = l[1];
    }
    lengths.push(end - at - lengths.reduce((a, b) => a + b, 0));
  } else {
    if ((end - at) % count) return [];
    for (let i = 0; i < count; i++) lengths.push((end - at) / count);
  }
  if (lengths.some(l => l < 0)) return [];
  return lengths.map(l => p.subarray(at, (at += l)));
}

/**
 * How much padding a packet of many frames has, and where its frames' lengths start.
 * @param {Buffer} p @returns {{ at: number; pad: number } | null} None for one cut short.
 */
function paddingOf(p) {
  let [at, pad] = [2, 0];
  for (;;) {
    if (at >= p.length) return null;
    const b = p[at++];
    pad += b === 255 ? 254 : b;
    if (b !== 255) return { at, pad };
  }
}

/** Frames of one kind as one packet. @param {number} kind The kind's byte, less its two last bits. @param {Buffer[]} frames */
function packet(kind, frames) {
  if (frames.length === 1) return Buffer.concat([Buffer.from([kind]), frames[0]]);
  const lengths = frames.slice(0, -1).flatMap(f => writeLength(f.length));
  return Buffer.concat([Buffer.from([kind | 3, 0x80 | frames.length, ...lengths]), ...frames]);
}

/** One speaker's packets, of whatever length, as packets of 20 ms. */
export class Twenties {
  kind = 0;
  /** @type {Buffer[]} Frames waiting for more to make 20 ms. */
  waiting = [];

  /** @param {Buffer} opus A packet as it came. @returns {Buffer[]} Packets of 20 ms now whole. */
  push(opus) {
    const out = [];
    const kind = opus[0] & 0xfc;
    for (const frame of framesOf(opus)) {
      // Another kind of frame cannot share a packet with what waits: that goes first, as it is.
      if (this.waiting.length && kind !== this.kind) out.push(...this.flush());
      this.kind = kind;
      this.waiting.push(Buffer.from(frame));
      if (this.waiting.length * frameMs(kind) >= 20) out.push(...this.flush());
    }
    return out;
  }

  /** What waits, short of 20 ms as it may be: at the end of an utterance. @returns {Buffer[]} */
  flush() {
    if (!this.waiting.length) return [];
    const out = packet(this.kind, this.waiting);
    this.waiting = [];
    return [out];
  }
}
