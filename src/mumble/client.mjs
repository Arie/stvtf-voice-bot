// The bot on a Mumble server: signed in as a bot, in one channel, marked as recording (Mumble's
// own flag: its clients show it, and say so when it starts), and handing on each speaker's Opus
// as the server passes it. Voice comes over this one connection: the bot never sets up the
// separate voice channel, so the server tunnels it here.
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

/** @typedef {{ session: number; name: string; channel: number; id: string }} Person */

export class MumbleClient {
  /**
   * @param {{
   *   host: string; port?: number; username: string; password?: string; channel: string;
   *   onVoice?: (v: { session: number; name: string; id: string; opus: Buffer; last: boolean }) => void;
   *   onGone?: (why: string) => void; onText?: (from: Person | undefined, text: string) => void;
   *   connect?: () => import("node:stream").Duplex; every?: (f: () => void, ms: number) => () => void;
   *   cert?: string; key?: string;
   * }} o `channel` is a channel's name, whatever its case.
   */
  constructor(o) {
    this.o = o;
    /** @type {Map<number, Person>} By session. */
    this.users = new Map();
    /** @type {Map<number, string>} Channels' names by id. */
    this.channels = new Map();
    this.session = -1;
    this.channel = -1;
    this.gone = false;
  }

  /** Signs in and goes to the channel: resolves once there, rejects with why not. */
  join() {
    const o = this.o;
    const connect = o.connect ?? (() => tls.connect({ host: o.host, port: o.port ?? 64738, rejectUnauthorized: false, cert: o.cert, key: o.key }));
    // Neither timer keeps the process going by itself.
    const every = o.every ?? ((f, ms) => (t => () => clearInterval(t))(setInterval(f, ms).unref()));
    return new Promise((resolve, reject) => {
      const fail = (/** @type {string} */ why) => {
        reject(new Error(why));
        this.#end(why);
      };
      const timer = setTimeout(() => fail("the server did not let me in in time"), JOIN_MS).unref();
      const done = () => clearTimeout(timer);
      this.socket = connect();
      const frames = new Frames();
      this.socket.on("data", chunk => {
        try {
          for (const m of frames.push(chunk)) this.#got(m.type, m.body, () => (done(), resolve(undefined)), why => (done(), fail(why)));
        } catch (e) {
          done();
          fail(`the server sent what I cannot read (${/** @type {Error} */ (e).message})`);
        }
      });
      this.socket.on("error", e => (done(), fail(`the connection failed (${e.message})`)));
      this.socket.on("close", () => (done(), fail("the connection closed")));
      this.#send("Version", { version_v1: VERSION, release: "stv.tf voice bot", os: "bot" });
      this.#send("Authenticate", { username: o.username, password: o.password, opus: true, client_type: BOT });
      this.stopPings = every(() => this.#send("Ping", { timestamp: Date.now() }), PING_MS);
    });
  }

  /** @param {keyof typeof import("./proto.mjs").TYPES} type @param {Record<string, unknown>} message */
  #send(type, message) {
    if (!this.gone) this.socket?.write(frame(type, encode(type, message)));
  }

  /**
   * @param {string} type @param {Buffer} body @param {() => void} joined @param {(why: string) => void} fail
   */
  #got(type, body, joined, fail) {
    if (type === "UDPTunnel") {
      const v = parseVoice(body);
      const who = v && this.users.get(v.session);
      if (v && who) this.o.onVoice?.({ session: v.session, name: who.name, id: who.id, opus: Buffer.from(v.opus), last: v.last });
      return;
    }
    const m = decode(type, body);
    switch (type) {
      case "Reject":
        return fail(`the server refused me: ${m.reason ?? "no reason given"}`);
      case "ChannelState":
        if (m.name != null) this.channels.set(m.channel_id ?? 0, m.name);
        return;
      case "ChannelRemove":
        this.channels.delete(m.channel_id);
        return;
      case "UserState": {
        const u = this.users.get(m.session) ?? { session: m.session, name: "", channel: 0, id: "" };
        if (m.name != null) u.name = m.name;
        if (m.channel_id != null) u.channel = m.channel_id;
        // Who they are from one visit to the next: registered, else their certificate.
        if (m.user_id != null) u.id = `user:${m.user_id}`;
        else if (m.hash && !u.id) u.id = m.hash;
        this.users.set(m.session, u);
        return;
      }
      case "UserRemove":
        this.users.delete(m.session);
        if (m.session === this.session) this.#end(`I was removed from the server${m.reason ? `: ${m.reason}` : ""}`);
        return;
      case "ServerSync": {
        this.session = m.session;
        const want = this.o.channel.trim().toLowerCase();
        const found = [...this.channels].find(([, name]) => name.toLowerCase() === want);
        if (!found) return fail(`there is no channel "${this.o.channel}" there (there are: ${[...this.channels.values()].join(", ")})`);
        this.channel = found[0];
        // Muted: it only listens. Not deafened: a deafened client is sent no voice.
        this.#send("UserState", { session: this.session, channel_id: this.channel, self_mute: true, recording: true });
        return joined();
      }
      case "PermissionDenied":
        this.o.onText?.(undefined, `the server denied something: ${m.reason ?? `type ${m.type}`}`);
        return;
      case "TextMessage":
        this.o.onText?.(this.users.get(m.actor), String(m.message ?? ""));
        return;
    }
  }

  /** Those in the bot's channel, itself aside. @returns {Person[]} */
  people() {
    return [...this.users.values()].filter(u => u.channel === this.channel && u.session !== this.session);
  }

  /** Says `text` in the bot's channel. @param {string} text */
  say(text) {
    this.#send("TextMessage", { channel_id: [this.channel], message: text });
  }

  /** Leaves the server. @param {string} [why] */
  leave(why = "I left") {
    this.#end(why);
  }

  /** @param {string} why */
  #end(why) {
    if (this.gone) return;
    this.gone = true;
    this.stopPings?.();
    this.socket?.destroy();
    this.o.onGone?.(why);
  }
}
