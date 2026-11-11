// The bot on a Mumble server: signed in as a bot, in one channel, marked as recording (Mumble's
// own flag: its clients show it, and say so when it starts), and handing on each speaker's Opus
// as the server passes it. Voice comes over this one connection: the bot never sets up the
// separate voice channel, so the server tunnels it here.
import net from "node:net";
import tls from "node:tls";
import { decode, encode, frame, Frames } from "./proto.mjs";
import { parseVoice } from "./voice.mjs";

// What the bot says it is: of before 1.5, so voice comes in the older packet form.
const VERSION = (1 << 16) | (4 << 8);
// A bot, to the server: not counted among its people.
const BOT = 1;
// How often it pings (a server drops a client silent for 30 s), and how long signing in may take.
const PING_MS = 15_000,
  JOIN_MS = 15_000;
// What is kept of a server's people and channels: more than any real one has is a server to leave.
const MAX_NAME = 128,
  MAX_USERS = 5000,
  MAX_CHANNELS = 5000;

/** @typedef {{ session: number; name: string; channel: number; id: string }} Person */

/**
 * Who someone on the server at `host` is to stv.tf: by their certificate, else as known there.
 * @param {string} host @param {{ id: string; session: number }} p
 */
export function voiceId(host, p) {
  const clean = (/** @type {string} */ t) => t.replace(/[^A-Za-z0-9:._-]/g, "");
  return p.id.startsWith("cert:") ? `mumble:${clean(p.id)}` : `mumble:${host}:${clean(p.id || `session:${p.session}`)}`;
}

/**
 * How to reach the server: at the address checked (not its name, which could be looked up anew),
 * with its name for TLS. Not verified: Mumble servers are mostly self-signed.
 * @param {{ host: string; address?: string; port?: number; cert?: string; key?: string }} o
 */
export const tlsOptions = o => ({
  host: o.address ?? o.host,
  port: o.port ?? 64738,
  servername: net.isIP(o.host) ? undefined : o.host,
  rejectUnauthorized: false,
  cert: o.cert,
  key: o.key,
});

export class MumbleClient {
  /**
   * @param {{
   *   host: string; address?: string; port?: number; username: string; password?: string; channel: string;
   *   onVoice?: (v: { session: number; name: string; id: string; opus: Buffer; last: boolean }) => void;
   *   onGone?: (why: string) => void; onText?: (from: Person | undefined, text: string) => void;
   *   connect?: () => import("node:stream").Duplex; every?: (f: () => void, ms: number) => () => void;
   *   cert?: string; key?: string;
   * }} o `channel` is a channel's name, whatever its case; `address`, where `host` is.
   */
  constructor(o) {
    this.o = o;
    /** @type {Map<number, Person>} By session. */
    this.users = new Map();
    /** @type {Map<number, string>} Channels' names by id. */
    this.channels = new Map();
    this.session = -1;
    this.channel = -1;
    /** Whether the server has it in its channel: only then is voice taken. */
    this.in = false;
    /** @type {(() => void) | null} Called once the server has moved it there. */
    this.moved = null;
    /** Called once in the channel, and with why not; set by join(). */
    this.joined = () => {};
    /** @type {(why: string, type?: number) => void} */
    this.fail = () => {};
    this.gone = false;
    /** @type {() => void} */
    this.wasClosed = () => {};
    /** Resolves once the connection is closed (or none was made). @type {Promise<void>} */
    this.closed = new Promise(r => (this.wasClosed = r));
  }

  /**
   * Signs in and goes to the channel: resolves once there, rejects with why not (and, for a
   * refusal, the Reject's type as `reject`).
   */
  join() {
    const o = this.o;
    const connect = o.connect ?? (() => tls.connect(tlsOptions(o)));
    // Neither timer keeps the process going by itself.
    const every =
      o.every ??
      ((f, ms) =>
        (
          t => () =>
            clearInterval(t)
        )(setInterval(f, ms).unref()));
    return new Promise((resolve, reject) => {
      /** @type {(why: string, type?: number) => void} */
      const fail = (why, type) => {
        reject(Object.assign(new Error(why), { reject: type }));
        this.#end(why);
      };
      const timer = setTimeout(() => fail("timed out"), JOIN_MS).unref();
      const done = () => clearTimeout(timer);
      this.joined = () => (done(), resolve(undefined));
      this.fail = (why, type) => (done(), fail(why, type));
      this.socket = connect();
      const frames = new Frames();
      this.socket.on("data", chunk => {
        try {
          for (const m of frames.push(chunk)) this.#got(m.type, m.body);
        } catch (e) {
          done();
          fail("bad reply");
        }
      });
      this.socket.on("error", e => (done(), fail(`connection failed (${e.message})`)));
      this.socket.on("close", () => (done(), fail("connection closed"), this.wasClosed()));
      this.#send("Version", { version_v1: VERSION, release: "stv.tf voice bot", os: "bot" });
      this.#send("Authenticate", { username: o.username, password: o.password, opus: true, client_type: BOT });
      this.stopPings = every(() => this.#send("Ping", { timestamp: Date.now() }), PING_MS);
    });
  }

  /** @param {keyof typeof import("./proto.mjs").TYPES} type @param {Record<string, unknown>} message */
  #send(type, message) {
    if (!this.gone) this.socket?.write(frame(type, encode(type, message)));
  }

  /** @param {string} type @param {Buffer} body */
  #got(type, body) {
    if (type === "UDPTunnel") return this.#voice(body);
    const m = decode(type, body);
    switch (type) {
      case "Reject":
        return this.fail(m.reason ?? "refused", m.type);
      case "ChannelState":
        return this.#channelState(m);
      case "ChannelRemove":
        return void this.channels.delete(m.channel_id);
      case "UserState":
        return this.#userState(m);
      case "UserRemove":
        return this.#userRemove(m);
      case "ServerSync":
        return this.#serverSync(m);
      case "PermissionDenied":
        return this.#denied(m);
      case "TextMessage":
        return this.o.onText?.(this.users.get(m.actor), String(m.message ?? ""));
    }
  }

  /** @param {Buffer} body */
  #voice(body) {
    const v = parseVoice(body);
    const who = v && this.users.get(v.session);
    // Talk to the channel only, from someone in it; never a whisper.
    if (v && who && this.in && v.target === 0 && who.channel === this.channel && v.session !== this.session)
      this.o.onVoice?.({ session: v.session, name: who.name, id: who.id, opus: Buffer.from(v.opus), last: v.last });
  }

  /** @param {Record<string, any>} m */
  #channelState(m) {
    if (m.name == null) return;
    if (!this.channels.has(m.channel_id ?? 0) && this.channels.size >= MAX_CHANNELS)
      return this.fail("too many channels");
    this.channels.set(m.channel_id ?? 0, m.name.slice(0, MAX_NAME));
  }

  /** @param {Record<string, any>} m */
  #userState(m) {
    if (!this.users.has(m.session) && this.users.size >= MAX_USERS) return this.fail("too many users");
    const u = this.users.get(m.session) ?? { session: m.session, name: "", channel: 0, id: "" };
    if (m.name != null) u.name = m.name.slice(0, MAX_NAME);
    if (m.channel_id != null) u.channel = m.channel_id;
    // Who they are from one visit to the next: their certificate, the same on any server;
    // else as registered on this one.
    if (m.hash) u.id = `cert:${m.hash.slice(0, MAX_NAME)}`;
    else if (m.user_id != null && !u.id.startsWith("cert:")) u.id = `user:${m.user_id}`;
    this.users.set(m.session, u);
    if (m.session !== this.session) return;
    if (this.moved && u.channel === this.channel) {
      this.in = true;
      this.moved();
      this.moved = null;
    } else if (this.in && u.channel !== this.channel) this.#end("moved");
  }

  /** @param {Record<string, any>} m */
  #userRemove(m) {
    this.users.delete(m.session);
    if (m.session === this.session) this.#end(`removed${m.reason ? `: ${m.reason}` : ""}`);
  }

  /** Refused something: the move to its channel, or something said. @param {Record<string, any>} m */
  #denied(m) {
    if (this.moved) return this.fail("move refused");
    this.o.onText?.(undefined, `denied: ${m.reason ?? m.type}`);
  }

  /** Signed in: to the channel. @param {Record<string, any>} m */
  #serverSync(m) {
    this.session = m.session;
    const want = this.o.channel.trim().toLowerCase();
    const found = [...this.channels].find(([, name]) => name.toLowerCase() === want);
    if (!found) return this.fail(`no channel "${this.o.channel}"`);
    this.channel = found[0];
    // Muted: it only listens. Not deafened: a deafened client is sent no voice. Joined once
    // the server says it is there.
    const there = this.users.get(this.session)?.channel === this.channel;
    this.#send("UserState", {
      session: this.session,
      channel_id: there ? undefined : this.channel,
      self_mute: true,
      recording: true,
    });
    if (!there) return void (this.moved = this.joined);
    this.in = true;
    this.joined();
  }

  /** Those in the bot's channel, itself aside. @returns {Person[]} */
  people() {
    return [...this.users.values()].filter(u => u.channel === this.channel && u.session !== this.session);
  }

  /** Says `text` in the bot's channel. @param {string} text */
  say(text) {
    this.#send("TextMessage", { channel_id: [this.channel], message: text });
  }

  /** Leaves the server: resolves once the connection is closed. @param {string} [why] */
  leave(why = "left") {
    this.#end(why);
    return this.closed;
  }

  /** @param {string} why */
  #end(why) {
    if (this.gone) return;
    this.gone = true;
    this.stopPings?.();
    this.socket?.destroy();
    if (!this.socket) this.wasClosed();
    this.o.onGone?.(why);
  }
}
