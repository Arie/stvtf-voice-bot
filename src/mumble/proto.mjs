// Mumble's control messages, as much of them as the bot needs: each a protobuf message, sent as
// a type (2 bytes), a length (4 bytes) and the message. Field numbers are Mumble.proto's.

/** The message types by name, as the connection numbers them. */
export const TYPES = {
  Version: 0,
  UDPTunnel: 1,
  Authenticate: 2,
  Ping: 3,
  Reject: 4,
  ServerSync: 5,
  ChannelRemove: 6,
  ChannelState: 7,
  UserRemove: 8,
  UserState: 9,
  TextMessage: 11,
  PermissionDenied: 12,
  CryptSetup: 15,
  CodecVersion: 21,
  ServerConfig: 24,
};
const NAMES = Object.fromEntries(Object.entries(TYPES).map(([name, n]) => [n, name]));

// Per message: field number → [name, kind], kind one of uint, bool, string; a `[]` after it for
// a repeated field.
/** @type {Record<string, Record<number, [string, string]>>} */
const FIELDS = {
  Version: { 1: ["version_v1", "uint"], 2: ["release", "string"], 3: ["os", "string"], 4: ["os_version", "string"] },
  Authenticate: {
    1: ["username", "string"],
    2: ["password", "string"],
    5: ["opus", "bool"],
    6: ["client_type", "uint"],
  },
  Ping: { 1: ["timestamp", "uint"] },
  Reject: { 1: ["type", "uint"], 2: ["reason", "string"] },
  ServerSync: { 1: ["session", "uint"], 3: ["welcome_text", "string"] },
  ChannelRemove: { 1: ["channel_id", "uint"] },
  ChannelState: { 1: ["channel_id", "uint"], 2: ["parent", "uint"], 3: ["name", "string"] },
  UserRemove: { 1: ["session", "uint"], 3: ["reason", "string"] },
  UserState: {
    1: ["session", "uint"],
    3: ["name", "string"],
    4: ["user_id", "uint"],
    5: ["channel_id", "uint"],
    9: ["self_mute", "bool"],
    10: ["self_deaf", "bool"],
    14: ["comment", "string"],
    15: ["hash", "string"],
    19: ["recording", "bool"],
  },
  TextMessage: { 1: ["actor", "uint"], 3: ["channel_id", "uint[]"], 5: ["message", "string"] },
  PermissionDenied: { 4: ["reason", "string"], 5: ["type", "uint"] },
};

/** @param {number} n A whole number, 0 and up. */
function writeVarint(n) {
  const out = [];
  let v = BigInt(n);
  while (v > 127n) {
    out.push(Number(v & 127n) | 128);
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

/** @param {Buffer} b @param {number} at @returns {[number, number]} The number, and where it ends. */
function readVarint(b, at) {
  // Ten bytes at most (64 bits); past 2^53 it is not exact, which nothing here needs.
  let v = 0;
  for (let i = 0; i < 10; i++) {
    if (at >= b.length) throw new Error("a number cut short");
    const byte = b[at++];
    v += (byte & 127) * 2 ** (7 * i);
    if (byte < 128) return [v, at];
  }
  throw new Error("a number too long");
}

/** @param {string} type @param {Record<string, unknown>} message */
export function encode(type, message) {
  const parts = [];
  for (const [number, [name, kind]] of Object.entries(FIELDS[type])) {
    const value = message[name];
    if (value == null) continue;
    for (const v of kind.endsWith("[]") ? /** @type {unknown[]} */ (value) : [value]) {
      if (kind.startsWith("string")) {
        const text = Buffer.from(String(v));
        parts.push(writeVarint((Number(number) << 3) | 2), writeVarint(text.length), text);
      } else parts.push(writeVarint(Number(number) << 3), writeVarint(Number(v)));
    }
  }
  return Buffer.concat(parts);
}

/** @param {string} type @param {Buffer} body @returns {Record<string, any>} The fields we know of. */
export function decode(type, body) {
  /** @type {Record<string, any>} */
  const out = {};
  const fields = FIELDS[type] ?? {};
  for (let at = 0; at < body.length;) {
    let tag, raw;
    [tag, at] = readVarint(body, at);
    [raw, at] = readValue(body, at, tag & 7);
    const [name, kind] = fields[tag >> 3] ?? [];
    const value = name ? typed(kind, raw) : undefined;
    if (value === undefined) continue;
    if (kind.endsWith("[]")) (out[name] ??= []).push(value);
    else out[name] = value;
  }
  return out;
}

/**
 * A field's value, of the wire type given: a number, the bytes of one of a length, or none for
 * those of fixed length (none of ours).
 * @param {Buffer} body @param {number} at @param {number} wire
 * @returns {[number | Buffer | undefined, number]} It, and where it ends.
 */
function readValue(body, at, wire) {
  switch (wire) {
    case 0:
      return readVarint(body, at);
    case 1:
      return [undefined, at + 8];
    case 2: {
      const [length, start] = readVarint(body, at);
      if (start + length > body.length) throw new Error("a field cut short");
      return [body.subarray(start, start + length), start + length];
    }
    case 5:
      return [undefined, at + 4];
    default:
      throw new Error(`a field of a kind unknown (${wire})`);
  }
}

/** A value as its field has it; none if it is not of that kind. @param {string} kind @param {number | Buffer | undefined} v */
function typed(kind, v) {
  if (kind.startsWith("string")) return Buffer.isBuffer(v) ? v.toString() : undefined;
  if (typeof v !== "number") return undefined;
  return kind === "bool" ? v !== 0 : v;
}

/** A message as the connection carries it. @param {keyof typeof TYPES} type @param {Buffer} body */
export function frame(type, body) {
  const head = Buffer.alloc(6);
  head.writeUInt16BE(TYPES[type], 0);
  head.writeUInt32BE(body.length, 2);
  return Buffer.concat([head, body]);
}

// The most a message is: more than any a server sends (its own limits are far lower) is a
// broken stream, or one meant to be.
const MAX_MESSAGE = 1 << 20;

/** The connection's bytes cut into messages, as they come. */
export class Frames {
  /** @type {Buffer[]} What has come and is not yet a whole message. */
  chunks = [];
  size = 0;
  /** How much the message at the front needs in all, once its head is in. */
  need = 0;

  /** @param {Buffer} chunk @returns {{ type: string; body: Buffer }[]} The messages now whole. */
  push(chunk) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    const out = [];
    for (;;) {
      if (!this.need) {
        if (this.size < 6) break;
        const length = this.#front(6).readUInt32BE(2);
        if (length > MAX_MESSAGE) throw new Error(`a message of ${length} bytes`);
        this.need = 6 + length;
      }
      if (this.size < this.need) break;
      const m = this.#front(this.need);
      const type = NAMES[m.readUInt16BE(0)] ?? `#${m.readUInt16BE(0)}`;
      out.push({ type, body: m.subarray(6, this.need) });
      this.chunks[0] = m.subarray(this.need);
      this.size -= this.need;
      this.need = 0;
    }
    return out;
  }

  /** The first chunk, made at least `n` bytes long out of those after it. @param {number} n */
  #front(n) {
    if (this.chunks[0].length < n) {
      let k = 0;
      for (let got = 0; got < n; k++) got += this.chunks[k].length;
      this.chunks.splice(0, k, Buffer.concat(this.chunks.slice(0, k)));
    }
    return this.chunks[0];
  }
}
