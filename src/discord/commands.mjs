// The `/stv` command with its subcommands, and the handlers for `leave` and `delay`. Only people
// in the bot's voice channel may control it: the voice is theirs, and a delay of 0 sends it out
// live.
import { ChannelType, SlashCommandBuilder } from "discord.js";
import { noMentions, reply } from "./messages.mjs";

export const DEFAULT_DELAY = 90;
const MAX_DELAY = 300;

const delayOption = (/** @type {import("discord.js").SlashCommandNumberOption} */ o) =>
  o
    .setName("delay")
    .setDescription(`tv_delay in seconds (default ${DEFAULT_DELAY}; 0 = instant)`)
    .setMinValue(0)
    .setMaxValue(MAX_DELAY);

export const command = new SlashCommandBuilder()
  .setName("stv")
  .setDescription("Voice comms for stv.tf")
  .addSubcommand(s =>
    s
      .setName("join")
      .setDescription("Record your voice channel for a match")
      .addStringOption(o =>
        o.setName("link").setDescription("Link from stv.tf (Comms → Copy command)").setRequired(true),
      )
      .addNumberOption(delayOption),
  )
  .addSubcommand(s => s.setName("leave").setDescription("Leave the voice channel"))
  .addSubcommand(s =>
    s
      .setName("delay")
      .setDescription("Change tv_delay")
      .addNumberOption(o => delayOption(o).setRequired(true)),
  )
  .addSubcommand(s => s.setName("link").setDescription("Link your Steam account"));

/**
 * @param {string | null | undefined} callerChannel The voice channel the caller is in.
 * @param {string} botChannel The one the bot is in.
 */
export const mayControl = (callerChannel, botChannel) => callerChannel === botChannel;

/** @typedef {import("./session.mjs").DiscordSession} DiscordSession */
/** @typedef {import("discord.js").ChatInputCommandInteraction} Interaction */

/**
 * The bot's session, if it is in a channel and whoever gave the command is in it too. Otherwise
 * replies why not and returns null.
 * @param {Interaction} i @param {DiscordSession | undefined} session @returns {Promise<DiscordSession | null>}
 */
async function controlled(i, session) {
  if (!session) {
    await reply(i, "Not in a channel.");
    return null;
  }
  const member = await i.guild?.members.fetch(i.user.id);
  if (mayControl(member?.voice.channelId, session.channel.id)) return session;
  await reply(i, "Join my voice channel first.");
  return null;
}

/** `/stv leave`. @param {Interaction} i @param {DiscordSession | undefined} session */
export async function leaveCommand(i, session) {
  const here = await controlled(i, session);
  if (!here) return;
  here.leave(`/stv leave by ${i.user.displayName}`);
  await reply(i, "Left.");
}

/** `/stv delay`. The delay is also posted in the recorded channel if the command was given elsewhere. @param {Interaction} i @param {DiscordSession | undefined} session */
export async function delayCommand(i, session) {
  const here = await controlled(i, session);
  if (!here) return;
  here.delay = i.options.getNumber("delay", true);
  const text = `tv_delay: ${here.delay} s${here.delay ? "" : " (live)"}`;
  if (here.channel.type === ChannelType.GuildVoice && i.channelId !== here.channel.id)
    here.channel.send(noMentions(text)).catch(() => {});
  await i.reply(noMentions(text));
}
