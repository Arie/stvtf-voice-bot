// The bot in one voice channel: it receives each speaker's Opus as Discord sends it and hands it,
// with who they are on Steam, to the match's forwarder. It leaves when told, when moved, when the
// channel is empty of people, or when the match is gone.
import { EndBehaviorType, VoiceConnectionStatus, entersState, joinVoiceChannel } from "@discordjs/voice";
import { Forwarder } from "../forward.mjs";
import { logOf } from "../log.mjs";
import { STATE, postStatus } from "../status.mjs";

// How often what is batched is flushed, how long joining may take, how often stv.tf is told how
// it goes and who is here, and how long a lost connection has to come back by itself.
const FLUSH_MS = 100,
  JOIN_MS = 30_000,
  STATUS_MS = 10_000,
  RECONNECT_MS = 5000;

export class DiscordSession {
  /**
   * @param {{
   *   channel: import("discord.js").VoiceBasedChannel; match: { voice: string; page: string; invite: string | null };
   *   delay: number; key: string; who: Pick<import("./who.mjs").Who, "peek" | "lookup">; onGone: (why: string) => Promise<unknown> | void;
   *   fetch?: typeof fetch; voice?: { joinVoiceChannel: typeof joinVoiceChannel; entersState: typeof entersState };
   *   print?: (line: string) => void;
   * }} o `fetch`, `voice` and `print` are for tests.
   */
  constructor(o) {
    this.o = o;
    this.channel = o.channel;
    this.forwarder = new Forwarder({
      url: o.match.voice,
      key: o.key,
      delay: o.delay,
      channel: o.channel.id,
      invite: o.match.invite ?? undefined,
      fetch: o.fetch,
      onStop: why => this.leave(why),
      onAnswer: answer => this.log(answer),
    });
    this.voice = o.voice ?? { joinVoiceChannel, entersState };
    /** What stv.tf answers its posts, or why they failed: logged when it changes. */
    this.log = logOf(`${o.channel.guild.name} → ${o.match.page}`, o.print);
    /** That it came into the channel, and why it left. */
    this.logStatus = logOf(`${o.channel.guild.name} → ${o.match.page}`, o.print);
    /** @type {Set<string>} Discord user ids heard. */
    this.heard = new Set();
    /** @type {Map<string, Promise<void>>} Each speaker's frames on their way to the forwarder, in order. */
    this.frames = new Map();
    this.gone = false;
    /** Whether it got into the channel. */
    this.inChannel = false;
    /** @type {Promise<void> | null} Once told to leave: resolves when its goodbyes are out. */
    this.leaving = null;
  }

  /** How far the match's stream is behind, in seconds: for what is said from now on. */
  get delay() {
    return this.forwarder.delay;
  }

  set delay(d) {
    this.forwarder.delay = d;
  }

  async join() {
    const { channel } = this;
    this.connection = this.voice.joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
    // Unheard, it would end the process: it only ends this channel.
    this.connection.on("error", () => this.leave("voice error"));
    await this.voice.entersState(this.connection, VoiceConnectionStatus.Ready, JOIN_MS);
    this.inChannel = true;
    this.logStatus(`In ${channel.name}`);
    this.connection.on(VoiceConnectionStatus.Disconnected, () => this.#disconnected());
    this.connection.receiver.speaking.on("start", id => this.#hear(id));
    this.timer = setInterval(() => this.forwarder.flush(), FLUSH_MS);
    this.reportStatus();
    this.reporting = setInterval(() => this.reportStatus(), STATUS_MS);
  }

  /** Lost a moment (a network hiccup, a voice server moved) it reconnects by itself; else it is gone. */
  async #disconnected() {
    const connection = /** @type {import("@discordjs/voice").VoiceConnection} */ (this.connection);
    try {
      await Promise.race([
        this.voice.entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_MS),
        this.voice.entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_MS),
      ]);
    } catch {
      this.leave("disconnected");
    }
  }

  /** @param {string} id A Discord user id, the first time they talk. */
  #hear(id) {
    if (this.heard.has(id) || !this.connection) return;
    this.heard.add(id);
    const stream = this.connection.receiver.subscribe(id, { end: { behavior: EndBehaviorType.Manual } });
    stream.on("data", (/** @type {Buffer} */ opus) => this.#frame(id, opus));
    stream.on("error", () => this.heard.delete(id));
  }

  /** @param {string} id @param {Buffer} opus */
  #frame(id, opus) {
    // Who they are is known from their first frame on; while it is asked, theirs wait in order.
    const before = this.frames.get(id) ?? Promise.resolve();
    const then = before.then(async () => {
      const steamid = this.o.who.peek(id) ?? (await this.o.who.lookup(id));
      const member = this.channel.guild.members.cache.get(id);
      this.forwarder.add({ steamid, id, name: member?.displayName ?? "someone" }, opus);
    });
    this.frames.set(id, then);
  }

  /** Those in the channel now who have no Steam link, by display name. */
  async unlinked() {
    const out = [];
    for (const m of this.channel.members.values())
      if (!m.user.bot && !(await this.o.who.lookup(m.id))) out.push(m.displayName);
    return out;
  }

  /** Tells stv.tf how it goes here and who is in the channel, so they can be put on players. */
  reportStatus() {
    if (this.gone) return;
    const people = [...this.channel.members.values()]
      .filter(m => !m.user.bot)
      .map(m => ({ id: m.id, name: m.displayName }));
    const status = `${this.channel.name} · ${people.length}`;
    // A channel nobody talks in hears of a match gone here: no voice post is answered so.
    postStatus(this.#statusTarget(), {
      kind: "discord",
      state: STATE.in,
      status,
      people,
      channel: this.channel.id,
    }).then(refused => {
      if (refused) this.leave(refused);
    });
  }

  /** Where stv.tf is told how it goes. */
  #statusTarget() {
    return { page: this.o.match.page, key: this.o.key, invite: this.o.match.invite, fetch: this.o.fetch };
  }

  /**
   * Someone's voice state changed on the server.
   * @param {{ id: string; channelId: string | null }} old @param {{ id: string; channelId: string | null }} now
   */
  update(old, now) {
    // The bot dragged elsewhere would record there, unsaid.
    if (now.id === this.channel.guild.members.me?.id && now.channelId !== this.channel.id)
      return this.leave(now.channelId ? "moved" : "disconnected");
    // Only who is here matters: not a mute, nor another channel.
    if (old.channelId === now.channelId || (old.channelId !== this.channel.id && now.channelId !== this.channel.id))
      return;
    if (!this.hasPeople()) return this.leave("channel empty");
    // Someone came or went: stv.tf hears who is here now.
    this.reportStatus();
  }

  /** Whether anyone but bots is in the channel. */
  hasPeople() {
    return [...this.channel.members.values()].some(m => !m.user.bot);
  }

  /** @param {string} why @returns {Promise<void>} Once stv.tf is told, what was said is posted, and the channel told. */
  leave(why) {
    if (this.leaving) return this.leaving;
    this.gone = true;
    this.logStatus(`Leaving: ${why}`);
    clearInterval(this.timer);
    clearInterval(this.reporting);
    const told = postStatus(this.#statusTarget(), {
      kind: "discord",
      state: this.inChannel ? STATE.left : STATE.failed,
      left: true,
      channel: this.channel.id,
    });
    const posted = this.forwarder.stop();
    try {
      this.connection?.destroy();
    } catch {}
    const said = this.o.onGone(why);
    this.leaving = Promise.allSettled([told, posted, said]).then(() => {});
    return this.leaving;
  }
}
