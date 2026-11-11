// The bot in one voice channel: it receives each speaker's Opus as Discord sends it and hands it,
// with who they are on Steam, to the match's forwarder. It leaves when told, when the channel is
// empty of people, or when the match is gone.
import { EndBehaviorType, VoiceConnectionStatus, entersState, joinVoiceChannel } from "@discordjs/voice";
import { Forwarder } from "./forward.mjs";
import { tell } from "./status.mjs";

// How often what is batched is flushed, how long joining may take, and how often stv.tf is told
// how it goes and who is here.
const FLUSH_MS = 100,
  JOIN_MS = 30_000,
  STATUS_MS = 10_000;

export class Channel {
  /**
   * @param {{
   *   channel: import("discord.js").VoiceBasedChannel; match: { voice: string; page: string; invite: string | null };
   *   delay: number; key: string; who: Pick<import("./who.mjs").Who, "peek" | "steamid">; onGone: (why: string) => void;
   *   fetch?: typeof fetch; voice?: { joinVoiceChannel: typeof joinVoiceChannel; entersState: typeof entersState };
   * }} o `fetch` and `voice` are for tests.
   */
  constructor(o) {
    this.o = o;
    this.channel = o.channel;
    this.forwarder = new Forwarder({ url: o.match.voice, key: o.key, delay: o.delay, channel: o.channel.id, invite: o.match.invite ?? undefined, fetch: o.fetch, onStop: why => this.leave(why), onSaid: said => this.#log(said) });
    this.voice = o.voice ?? { joinVoiceChannel, entersState };
    /** What stv.tf last answered, its numbers aside: logged when it changes. */
    this.answered = "";
    /** @type {Set<string>} Discord user ids heard. */
    this.heard = new Set();
    /** @type {Map<string, Promise<void>>} Each speaker's frames on their way to the forwarder, in order. */
    this.frames = new Map();
    this.gone = false;
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
    this.connection.on(VoiceConnectionStatus.Disconnected, () => this.leave("disconnected"));
    this.connection.receiver.speaking.on("start", id => this.#hear(id));
    this.timer = setInterval(() => this.forwarder.flush(), FLUSH_MS);
    this.report();
    this.reporting = setInterval(() => this.report(), STATUS_MS);
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
      const steamid = this.o.who.peek(id) ?? (await this.o.who.steamid(id));
      const member = this.channel.guild.members.cache.get(id);
      this.forwarder.frame({ steamid, discord: id, name: member?.displayName ?? "someone" }, opus);
    });
    this.frames.set(id, then);
  }

  /** @param {string} said What stv.tf answered a post, or why it failed. */
  #log(said) {
    const kind = said.replace(/\d+$/, "");
    if (kind === this.answered) return;
    this.answered = kind;
    console.log(`stvtf-voice-bot: ${this.channel.guild.name} → ${this.o.match.page}: ${said}`);
  }

  /** Those in the channel now who have no Steam link, by display name. */
  async unlinked() {
    const out = [];
    for (const m of this.channel.members.values())
      if (!m.user.bot && !(await this.o.who.steamid(m.id))) out.push(m.displayName);
    return out;
  }

  /** Tells stv.tf how it goes here and who is in the channel, so they can be put on players. */
  report() {
    if (this.gone) return;
    const people = [...this.channel.members.values()].filter(m => !m.user.bot).map(m => ({ id: m.id, name: m.displayName }));
    const status = `${this.channel.name} · ${people.length}`;
    tell(this.#to(), { kind: "discord", status, people, channel: this.channel.id });
  }

  /** Where stv.tf is told how it goes. */
  #to() {
    return { page: this.o.match.page, key: this.o.key, invite: this.o.match.invite, fetch: this.o.fetch };
  }

  /** Whether anyone but bots is in the channel. */
  hasPeople() {
    return [...this.channel.members.values()].some(m => !m.user.bot);
  }

  /** @param {string} why */
  leave(why) {
    if (this.gone) return;
    this.gone = true;
    clearInterval(this.timer);
    clearInterval(this.reporting);
    tell(this.#to(), { kind: "discord", left: true, channel: this.channel.id });
    this.forwarder.stopped = true;
    try {
      this.connection?.destroy();
    } catch {}
    this.o.onGone(why);
  }
}
