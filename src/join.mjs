// `/stv join`: into the caller's voice channel, for the match its link names.
import { ChannelType, MessageFlags } from "discord.js";
import { matchOf } from "./match.mjs";

/**
 * @typedef {{
 *   join: () => Promise<void>; leave: (why: string) => void; unlinked: () => Promise<string[]>;
 * }} Joined
 */

/** @param {import("discord.js").ChatInputCommandInteraction} i @param {string} content */
export const reply = (i, content) => i.reply({ content, flags: MessageFlags.Ephemeral });

/** What the bot says where others see it: names in it (any can be `@everyone`) mention nobody. @param {string} content */
export const said = content => ({ content, allowedMentions: { parse: /** @type {[]} */ ([]) } });

/**
 * @param {import("discord.js").ChatInputCommandInteraction} i
 * @param {{
 *   hosts: string[]; key: string; nick: string; defaultDelay: number;
 *   channels: Map<string, Joined>; joining: Set<string>;
 *   whoFor: (url: string) => import("./who.mjs").Who;
 *   makeChannel: (o: ConstructorParameters<typeof import("./channel.mjs").Channel>[0]) => Joined;
 * }} o `channels`: the one the bot is in, by server; `joining`: servers it is on its way into.
 */
export async function join(i, o) {
  const { channels, joining } = o;
  const member = await i.guild?.members.fetch(i.user.id);
  const voice = member?.voice.channel;
  if (!voice || !i.guild) return reply(i, "Join a voice channel first.");
  if (channels.has(i.guild.id) || joining.has(i.guild.id))
    return reply(i, "Already in a channel. `/stv leave` first.");
  const match = matchOf(i.options.getString("link", true), o.hosts);
  if (!match) return reply(i, "Not a stv.tf link.");
  if (!match.invite)
    return reply(i, "No invite in that link. On the match page: 🔊 → Comms → Copy command.");
  const delay = i.options.getNumber("delay") ?? o.defaultDelay;
  const guildId = i.guild.id;
  // Held from here on, until it is in or not: a second join meanwhile is told so.
  joining.add(guildId);
  try {
    await joinIn(i, o, voice, match, delay);
  } finally {
    joining.delete(guildId);
  }
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} i @param {Parameters<typeof join>[1]} o
 * @param {import("discord.js").VoiceBasedChannel} voice @param {NonNullable<ReturnType<typeof matchOf>>} match @param {number} delay
 */
async function joinIn(i, o, voice, match, delay) {
  const guild = /** @type {import("discord.js").Guild} */ (i.guild);
  await i.deferReply();
  const channel = o.makeChannel({
    channel: voice,
    match,
    delay,
    key: o.key,
    who: o.whoFor(match.who),
    onGone: why => {
      o.channels.delete(guild.id);
      guild.members.me?.setNickname(null).catch(() => {});
      if (voice.type === ChannelType.GuildVoice) voice.send(said(`Left: ${why}`)).catch(() => {});
    },
  });
  try {
    await channel.join();
  } catch {
    channel.leave("join failed");
    return i.editReply("Can't join that channel.");
  }
  o.channels.set(guild.id, channel);
  guild.members.me?.setNickname(o.nick).catch(() => {});
  // Said at once, as it is recording already; who has no link (a question per person) after.
  await i.editReply(said(`🔴 **Recording** for ${match.page} (${delay ? `delay ${delay} s` : "live"}). \`/stv leave\` to stop.`));
  const unlinked = await channel.unlinked();
  if (unlinked.length) await i.followUp(said(`Not linked: ${unlinked.join(", ")} (\`/stv link\`)`));
}
