// `/stv join`: the bot joins the caller's voice channel, for the match named in the link.
import { ChannelType } from "discord.js";
import { matchOf } from "../stvtf/match.mjs";
import { noMentions, reply } from "./messages.mjs";

/**
 * @typedef {{
 *   join: () => Promise<void>; leave: (why: string) => Promise<unknown> | void; unlinked: () => Promise<string[]>;
 *   hasPeople?: () => boolean;
 * }} Joined
 */

/**
 * @param {import("discord.js").ChatInputCommandInteraction} i
 * @param {{
 *   hosts: string[]; key: string; nick: string; defaultDelay: number;
 *   sessions: Map<string, Joined>; joining: Set<string>; kept: import("./kept.mjs").Kept;
 *   whoFor: (url: string) => import("./who.mjs").Who;
 *   makeSession: (o: ConstructorParameters<typeof import("./session.mjs").DiscordSession>[0]) => Joined;
 * }} o `sessions`: the bot's session in each server; `joining`: servers where a join is in
 *   progress; `kept`: the channels it rejoins after a restart.
 */
export async function joinCommand(i, o) {
  const { sessions, joining } = o;
  const member = await i.guild?.members.fetch(i.user.id);
  const voice = member?.voice.channel;
  if (!voice || !i.guild) return reply(i, "Join a voice channel first.");
  if (sessions.has(i.guild.id) || joining.has(i.guild.id)) return reply(i, "Already in a channel. `/stv leave` first.");
  const match = matchOf(i.options.getString("link", true), o.hosts);
  if (!match) return reply(i, "Not a stv.tf link.");
  if (!match.invite) return reply(i, "No invite in that link. On the match page: 🔊 → Comms → Copy command.");
  const delay = i.options.getNumber("delay") ?? o.defaultDelay;
  const guildId = i.guild.id;
  // Marked as joining until the join succeeds or fails: a second `/stv join` meanwhile is refused.
  joining.add(guildId);
  try {
    await joinAndAnnounce(i, o, voice, match, delay);
    if (sessions.has(guildId))
      o.kept.add({ guild: guildId, channel: voice.id, link: i.options.getString("link", true), delay });
  } finally {
    joining.delete(guildId);
  }
}

/**
 * Joins `voice` for `match` and returns the session. When the session ends it says so in the
 * channel, unless the bot is only stopping with its channels saved (it rejoins them).
 * @param {Parameters<typeof joinCommand>[1]} o @param {import("discord.js").Guild} guild
 * @param {import("discord.js").VoiceBasedChannel} voice @param {NonNullable<ReturnType<typeof matchOf>>} match @param {number} delay
 * @throws If it cannot join.
 */
async function enter(o, guild, voice, match, delay) {
  const session = o.makeSession({
    channel: voice,
    match,
    delay,
    key: o.key,
    who: o.whoFor(match.whoUrl),
    onGone: why => {
      // Only a session that got in says it left. A failed join is reported by the caller.
      if (o.sessions.get(guild.id) !== session) return;
      o.sessions.delete(guild.id);
      // The bot is stopping and its channels are saved: say nothing, it rejoins after the restart.
      if (o.kept.stopping && o.kept.path) return;
      o.kept.forget(guild.id);
      return Promise.allSettled([
        guild.members.me?.setNickname(null),
        voice.type === ChannelType.GuildVoice && voice.send(noMentions(`Left: ${why}`)),
      ]);
    },
  });
  try {
    await session.join();
  } catch (e) {
    session.leave("join failed");
    throw e;
  }
  o.sessions.set(guild.id, session);
  guild.members.me?.setNickname(o.nick).catch(() => {});
  return session;
}

/**
 * Rejoins a channel saved before a restart, without announcing it. Forgets the channel if it
 * cannot be rejoined.
 * @param {import("discord.js").Client} client @param {Parameters<typeof joinCommand>[1]} o
 * @param {import("./kept.mjs").KeptChannel} kept
 */
export async function rejoin(client, o, kept) {
  const match = matchOf(kept.link, o.hosts);
  const guild = await client.guilds.fetch(kept.guild).catch(() => null);
  const voice = await guild?.channels.fetch(kept.channel).catch(() => null);
  if (!match || !guild || !voice?.isVoiceBased() || o.sessions.has(guild.id)) return o.kept.forget(kept.guild);
  try {
    const session = await enter(o, guild, voice, match, kept.delay);
    // Everyone left while the bot was away.
    if (session.hasPeople?.() === false) session.leave("channel empty");
  } catch {
    o.kept.forget(kept.guild);
    // The bot kept its recording nickname when it stopped, so clear it now.
    guild.members.me?.setNickname(null).catch(() => {});
  }
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} i @param {Parameters<typeof joinCommand>[1]} o
 * @param {import("discord.js").VoiceBasedChannel} voice @param {NonNullable<ReturnType<typeof matchOf>>} match @param {number} delay
 */
async function joinAndAnnounce(i, o, voice, match, delay) {
  const guild = /** @type {import("discord.js").Guild} */ (i.guild);
  await i.deferReply();
  let session;
  try {
    session = await enter(o, guild, voice, match, delay);
  } catch {
    return i.editReply("Can't join that channel.");
  }
  // Announced at once, because it is recording already. Who is not linked follows: that takes a
  // request per person.
  await i.editReply(
    noMentions(`🔴 **Recording** for ${match.page} (${delay ? `delay ${delay} s` : "live"}). \`/stv leave\` to stop.`),
  );
  const unlinked = await session.unlinked();
  if (unlinked.length) await i.followUp(noMentions(`Not linked: ${unlinked.join(", ")} (\`/stv link\`)`));
}
