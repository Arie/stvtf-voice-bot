// Voice as a Mumble server passes it on (its older packet form, which it sends a client that
// says it is of before 1.5): who talks, a sequence number, and one Opus packet, the last of an
// utterance marked. Over the control connection it comes in UDPTunnel messages, as is.

// The codec a packet's first byte names in its top three bits; Opus is the only one of today.
const OPUS = 4;
// In an Opus packet's length: the utterance ends with it.
const LAST = 0x2000;

/**
 * One of Mumble's own variable-length numbers (not protobuf's), of those that are not negative.
 * @param {Buffer} b @param {number} at @returns {[number, number] | null} It, and how long it is.
 */
export function varint(b, at) {
  const first = b[at];
  if (first === undefined) return null;
  /** @type {[number, number]} how many bytes follow, and what of the first byte counts */
  const [more, mask] =
    first < 0x80 ? [0, 0x7f] : first < 0xc0 ? [1, 0x3f] : first < 0xe0 ? [2, 0x1f] : first < 0xf0 ? [3, 0x0f] : [4, 0];
  if (first >= 0xf4 || at + more >= b.length + (more ? 0 : 1)) return null;
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
  return { target: packet[0] & 31, session, sequence, opus: packet.subarray(at, at + length), last: (size & LAST) !== 0 };
}

/**
 * How many milliseconds of sound an Opus packet holds, from its first byte (and its second, for
 * one of many frames): 0 for none.
 * @param {Buffer} opus
 */
export function opusDuration(opus) {
  if (!opus.length) return 0;
  const config = opus[0] >> 3;
  const frame = config < 12 ? [10, 20, 40, 60][config & 3] : config < 16 ? [10, 20][config & 1] : [2.5, 5, 10, 20][config & 3];
  const code = opus[0] & 3;
  const frames = code === 0 ? 1 : code < 3 ? 2 : (opus[1] ?? 0) & 0x3f;
  return frame * frames;
}
