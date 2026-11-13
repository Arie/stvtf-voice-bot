// The bot on a Mumble server: signed in as a bot, in one channel, marked as recording (Mumble's
// own flag: its clients show it, and say so when it starts), and handing on each speaker's Opus
// as the server passes it. Voice comes over this one connection: the bot never sets up the
// separate voice channel, so the server tunnels it here.
import net from "node:net";
import tls from "node:tls";
import { decode, encode, frame, Frames } from "./proto.mjs";
import { ServerState } from "./server-state.mjs";
import { parseVoice } from "./voice.mjs";

/** @typedef {import("./proto.mjs").Messages} Messages */
/** @typedef {import("./server-state.mjs").Person} Person */

// What the bot says it is: of before 1.5, so voice comes in the older packet form.
const VERSION = (1 << 16) | (4 << 8);
// A bot, to the server: not counted among its people.
const BOT = 1;
// How often it pings (a server drops a client silent for 30 s), and how long signing in may take.
const PING_MS = 15_000,
  JOIN_MS = 15_000;

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

/** Calls `f` every `ms`, keeping the process going no longer: returns how to stop. @param {() => void} f @param {number} ms */
function repeatUnref(f, ms) {
  const timer = setInterval(f, ms).unref();
  return () => clearInterval(timer);
}

export class MumbleClient {
  /** @type {(() => void) | null} Set while it waits for the server to move it to its channel. */
  #onMovedIn = null;
  /** Ends join() once in the channel, or with why not. */
  #resolveJoin = () => {};
  /** @type {(why: string, type?: number) => void} */
  #rejectJoin = () => {};
  /** @type {() => void} */
  #markClosed = () => {};

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
    this.server = new ServerState(why => this.#rejectJoin(why));
    this.session = -1;
    this.channel = -1;
    /** Whether the server has it in its channel: only then is voice taken. */
    this.inChannel = false;
    this.gone = false;
    /** Resolves once the connection is closed (or none was made). @type {Promise<void>} */
    this.closed = new Promise(r => (this.#markClosed = r));
  }

  /**
   * Signs in and goes to the channel: resolves once there, rejects with why not (and, for a
   * refusal, the Reject's type as `reject`).
   */
  join() {
    return new Promise((resolve, reject) => {
      // Neither timer keeps the process going by itself.
      const timer = setTimeout(() => this.#rejectJoin("timed out"), JOIN_MS).unref();
      this.#resolveJoin = () => {
        clearTimeout(timer);
        resolve(undefined);
      };
      // Once in, there is nothing to reject: what comes after only ends the connection.
      this.#rejectJoin = (why, type) => {
        clearTimeout(timer);
        reject(Object.assign(new Error(why), { reject: type }));
        this.#end(why);
      };
      this.#connect();
      this.#signIn();
    });
  }

  /** Opens the connection, and reads the server's messages off it. */
  #connect() {
    const socket = (this.socket = (this.o.connect ?? (() => tls.connect(tlsOptions(this.o))))());
    const frames = new Frames();
    socket.on("data", chunk => {
      try {
        for (const m of frames.push(chunk)) this.#onMessage(m.type, m.body);
      } catch {
        this.#rejectJoin("bad reply");
      }
    });
    socket.on("error", e => this.#rejectJoin(`connection failed (${e.message})`));
    socket.on("close", () => {
      this.#rejectJoin("connection closed");
      this.#markClosed();
    });
  }

  /** Says who it is, and pings from then on. */
  #signIn() {
    this.#send("Version", { version_v1: VERSION, release: "stv.tf voice bot", os: "bot" });
    this.#send("Authenticate", { username: this.o.username, password: this.o.password, opus: true, client_type: BOT });
    this.stopPings = (this.o.every ?? repeatUnref)(() => this.#send("Ping", { timestamp: Date.now() }), PING_MS);
  }

  /** @template {keyof Messages} T @param {T} type @param {Messages[T]} message */
  #send(type, message) {
    if (!this.gone) this.socket?.write(frame(type, encode(type, message)));
  }

  /** @param {string} type @param {Buffer} body */
  #onMessage(type, body) {
    switch (type) {
      case "UDPTunnel":
        return this.#voice(body);
      case "Reject":
        return this.#reject(decode("Reject", body));
      case "ChannelState":
        return this.server.applyChannelState(decode("ChannelState", body));
      case "ChannelRemove":
        return this.server.applyChannelRemove(decode("ChannelRemove", body));
      case "UserState":
        return this.#userState(decode("UserState", body));
      case "UserRemove":
        return this.#userRemove(decode("UserRemove", body));
      case "ServerSync":
        return this.#serverSync(decode("ServerSync", body));
      case "PermissionDenied":
        return this.#permissionDenied(decode("PermissionDenied", body));
      case "TextMessage":
        return this.#textMessage(decode("TextMessage", body));
    }
  }

  /** @param {import("./proto.mjs").Reject} m */
  #reject(m) {
    this.#rejectJoin(m.reason ?? "refused", m.type);
  }

  /** @param {import("./proto.mjs").TextMessage} m */
  #textMessage(m) {
    this.o.onText?.(m.actor == null ? undefined : this.server.users.get(m.actor), String(m.message ?? ""));
  }

  /** @param {Buffer} body */
  #voice(body) {
    const v = parseVoice(body);
    const who = v && this.server.users.get(v.session);
    // Talk to the channel only, from someone in it; never a whisper.
    if (v && who && this.inChannel && v.target === 0 && who.channel === this.channel && v.session !== this.session)
      this.o.onVoice?.({ session: v.session, name: who.name, id: who.id, opus: Buffer.from(v.opus), last: v.last });
  }

  /** @param {import("./proto.mjs").UserState} m */
  #userState(m) {
    const u = this.server.applyUserState(m);
    if (u && u.session === this.session) this.#ownChannelIs(u.channel);
  }

  /** Where the server has put the bot: in its channel at last, or moved out of it. @param {number} channel */
  #ownChannelIs(channel) {
    if (this.#onMovedIn && channel === this.channel) {
      this.inChannel = true;
      this.#onMovedIn();
      this.#onMovedIn = null;
    } else if (this.inChannel && channel !== this.channel) this.#end("moved");
  }

  /** @param {import("./proto.mjs").UserRemove} m */
  #userRemove(m) {
    if (m.session == null) return;
    this.server.removeUser(m.session);
    if (m.session === this.session) this.#end(`removed${m.reason ? `: ${m.reason}` : ""}`);
  }

  /** Refused something: the move to its channel, or something said. @param {import("./proto.mjs").PermissionDenied} m */
  #permissionDenied(m) {
    if (this.#onMovedIn) return this.#rejectJoin("move refused");
    this.o.onText?.(undefined, `denied: ${m.reason ?? m.type}`);
  }

  /** Signed in: to the channel. @param {import("./proto.mjs").ServerSync} m */
  #serverSync(m) {
    this.session = m.session ?? -1;
    const found = this.server.channelNamed(this.o.channel);
    if (found === undefined) return this.#rejectJoin(`no channel "${this.o.channel}"`);
    this.channel = found;
    // Muted: it only listens. Not deafened: a deafened client is sent no voice. Joined once
    // the server says it is there.
    const there = this.server.users.get(this.session)?.channel === this.channel;
    this.#send("UserState", {
      session: this.session,
      channel_id: there ? undefined : this.channel,
      self_mute: true,
      recording: true,
    });
    if (!there) return void (this.#onMovedIn = this.#resolveJoin);
    this.inChannel = true;
    this.#resolveJoin();
  }

  /** Those in the bot's channel, itself aside. @returns {Person[]} */
  people() {
    return this.server.peopleIn(this.channel, this.session);
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
    if (!this.socket) this.#markClosed();
    this.o.onGone?.(why);
  }
}
