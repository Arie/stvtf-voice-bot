// `/stv join`: into the caller's voice channel, for the match its link names.
import { ChannelType } from "discord.js";
import { matchOf } from "../match.mjs";
import { noMentions, reply } from "./messages.mjs";

/**
 * @typedef {{
 *   join: () => Promise<void>; leave: (why: string) => Promise<unknown> | void; unlinked: () => Promise<string[]>;
 * }} Joined
 */

/**
 * @param {import("discord.js").ChatInputCommandInteraction} i
 * @param {{
 *   hosts: string[]; key: string; nick: string; defaultDelay: number;
 *   sessions: Map<string, Joined>; joining: Set<string>;
 *   whoFor: (url: string) => import("./who.mjs").Who;
 *   makeSession: (o: ConstructorParameters<typeof import("./session.mjs").DiscordSession>[0]) => Joined;
 * }} o `sessions`: the one the bot is in, by server; `joining`: servers it is on its way into.
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
  // Held from here on, until it is in or not: a second join meanwhile is told so.
  joining.add(guildId);
  try {
    await joinAndAnnounce(i, o, voice, match, delay);
  } finally {
    joining.delete(guildId);
  }
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} i @param {Parameters<typeof joinCommand>[1]} o
 * @param {import("discord.js").VoiceBasedChannel} voice @param {NonNullable<ReturnType<typeof matchOf>>} match @param {number} delay
 */
async function joinAndAnnounce(i, o, voice, match, delay) {
  const guild = /** @type {import("discord.js").Guild} */ (i.guild);
  await i.deferReply();
  const session = o.makeSession({
    channel: voice,
    match,
    delay,
    key: o.key,
    who: o.whoFor(match.whoUrl),
    onGone: why => {
      // Only one that was in says it left: one that would not join says so itself.
      if (o.sessions.get(guild.id) !== session) return;
      o.sessions.delete(guild.id);
      return Promise.allSettled([
        guild.members.me?.setNickname(null),
        voice.type === ChannelType.GuildVoice && voice.send(noMentions(`Left: ${why}`)),
      ]);
    },
  });
  try {
    await session.join();
  } catch {
    session.leave("join failed");
    return i.editReply("Can't join that channel.");
  }
  o.sessions.set(guild.id, session);
  guild.members.me?.setNickname(o.nick).catch(() => {});
  // Said at once, as it is recording already; who has no link (a question per person) after.
  await i.editReply(
    noMentions(`🔴 **Recording** for ${match.page} (${delay ? `delay ${delay} s` : "live"}). \`/stv leave\` to stop.`),
  );
  const unlinked = await session.unlinked();
  if (unlinked.length) await i.followUp(noMentions(`Not linked: ${unlinked.join(", ")} (\`/stv link\`)`));
}
