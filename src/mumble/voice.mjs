// Voice packets as a Mumble server passes them on, in the older format it sends to a client that
// reports a version before 1.5: who talks, a sequence number and one Opus packet, with a flag on
// the last packet of an utterance. Over the control connection they come unchanged inside
// UDPTunnel messages.

// The codec is in the top three bits of a packet's first byte. Only Opus is still in use.
const OPUS = 4;
// A flag bit in the Opus packet's length field: the utterance ends with this packet.
const LAST = 0x2000;

// The forms of Mumble's variable-length numbers, by first byte: [the first byte is below this,
// how many bytes follow, the mask for the value bits in the first byte]. From 0xf4 on they are
// other forms (negative, or 64 bits), which are not read.
const KINDS = [
  [0x80, 0, 0x7f],
  [0xc0, 1, 0x3f],
  [0xe0, 2, 0x1f],
  [0xf0, 3, 0x0f],
  [0xf4, 4, 0],
];

/**
 * Reads one of Mumble's own variable-length numbers (not protobuf's): only the forms that are
 * not negative and at most 32 bits.
 * @param {Buffer} b @param {number} at @returns {[number, number] | null} The number, and where it ends.
 */
export function readMumbleVarint(b, at) {
  const first = b[at];
  if (first === undefined) return null;
  const kind = KINDS.find(([below]) => first < below);
  if (!kind) return null;
  const [, more, mask] = kind;
  if (at + more >= b.length + (more ? 0 : 1)) return null;
  let v = first & mask;
  for (let i = 1; i <= more; i++) v = v * 256 + b[at + i];
  return [v, at + more + 1];
}

/**
 * @param {Buffer} packet What a UDPTunnel message holds.
 * @returns {{ target: number; session: number; sequence: number; opus: Buffer; last: boolean } | null}
 * Null for what is not Opus voice (a ping, an old codec) or is cut short. `target`: 0 is talk to
 * the channel; 1 to 30 a whisper or shout; 31 the server's loopback.
 */
export function parseVoice(packet) {
  if (packet.length < 2 || packet[0] >> 5 !== OPUS) return null;
  let at = 1;
  const numbers = [];
  for (let i = 0; i < 3; i++) {
    const n = readMumbleVarint(packet, at);
    if (!n) return null;
    numbers.push(n[0]);
    at = n[1];
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
 * How many milliseconds of sound an Opus packet holds, from its first byte (and its second,
 * which holds the frame count of a code 3 packet): 0 for an empty packet.
 * @param {Buffer} opus
 */
export function opusDuration(opus) {
  if (!opus.length) return 0;
  // By code (the low two bits): one frame; two frames (of equal or of different lengths); or as
  // many as the second byte says.
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
