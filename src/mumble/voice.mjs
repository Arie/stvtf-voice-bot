// Voice as a Mumble server passes it on (its older packet form, which it sends a client that
// says it is of before 1.5): who talks, a sequence number, and one Opus packet, the last of an
// utterance marked. Over the control connection it comes in UDPTunnel messages, as is.

// The codec a packet's first byte names in its top three bits; Opus is the only one of today.
const OPUS = 4;
// In an Opus packet's length: the utterance ends with it.
const LAST = 0x2000;

// The kinds of Mumble's numbers by their first byte: below what, how many bytes follow, and what
// of the first byte counts. From 0xf4 on, they are of another kind (negative, or 64 bits).
const KINDS = [
  [0x80, 0, 0x7f],
  [0xc0, 1, 0x3f],
  [0xe0, 2, 0x1f],
  [0xf0, 3, 0x0f],
  [0xf4, 4, 0],
];

/**
 * One of Mumble's own variable-length numbers (not protobuf's), of those that are not negative.
 * @param {Buffer} b @param {number} at @returns {[number, number] | null} It, and how long it is.
 */
export function varint(b, at) {
  const first = b[at];
  if (first === undefined) return null;
  const kind = KINDS.find(([below]) => first < below);
  if (!kind) return null;
  const [, more, mask] = kind;
  if (at + more >= b.length + (more ? 0 : 1)) return null;
  let v = first & mask;
  for (let i = 1; i <= more; i++) v = v * 256 + b[at + i];
  return [v, more + 1];
}

/**
 * @param {Buffer} packet What a UDPTunnel message holds.
 * @returns {{ target: number; session: number; sequence: number; opus: Buffer; last: boolean } | null}
 * None for what is no Opus voice (a ping, an old codec) or is cut short. `target`: 0 is talk to
 * the channel; 1 to 30 a whisper or shout; 31 the server's loopback.
 */
export function parseVoice(packet) {
  if (packet.length < 2 || packet[0] >> 5 !== OPUS) return null;
  let at = 1;
  const numbers = [];
  for (let i = 0; i < 3; i++) {
    const n = varint(packet, at);
    if (!n) return null;
    numbers.push(n[0]);
    at += n[1];
  }
  const [session, sequence, size] = numbers;
  const length = size & (LAST - 1);
  if (at + length > packet.length) return null;
  return {
    target: packet[0] & 31,
    session,
    sequence,
    opus: packet.subarray(at, at + length),
    last: (size & LAST) !== 0,
  };
}

/**
 * How many milliseconds of sound an Opus packet holds, from its first byte (and its second, for
 * one of many frames): 0 for none.
 * @param {Buffer} opus
 */
export function opusDuration(opus) {
  if (!opus.length) return 0;
  // One frame; two (of a length, or two); or as many as the second byte says.
  const frames = [1, 2, 2, (opus[1] ?? 0) & 0x3f][opus[0] & 3];
  return frameMs(opus[0]) * frames;
}

/** Milliseconds a frame of the kind an Opus packet's first byte (`toc`) names lasts. @param {number} toc */
export function frameMs(toc) {
  const config = toc >> 3;
  // SILK, hybrid, CELT.
  if (config < 12) return [10, 20, 40, 60][config & 3];
  if (config < 16) return [10, 20][config & 1];
  return [2.5, 5, 10, 20][config & 3];
}
