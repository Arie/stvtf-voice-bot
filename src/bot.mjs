// The stv.tf voice bot: `/stv join` brings it into the caller's voice channel, where it says it
// is recording and passes what is said to the match on stv.tf the link names, as the speakers'
// players (their Steam accounts, linked through Discord on stv.tf). One channel per server.
//
// Environment: DISCORD_TOKEN; STVTF_VOICE_KEY (the key stv.tf takes voice with); STVTF_HOSTS (the
// stv.tf hosts voice may go to, comma separated; default the four regions).
import { ChannelType, Client, GatewayIntentBits, MessageFlags, SlashCommandBuilder } from "discord.js";
import { Channel } from "./channel.mjs";
import { homeOf, matchOf } from "./match.mjs";
import { Who } from "./who.mjs";
import { mayControl } from "./control.mjs";

const HOSTS = (process.env.STVTF_HOSTS ?? "stv.tf,na.stv.tf,au.stv.tf,sea.stv.tf").split(",").map(h => h.trim());
const KEY = process.env.STVTF_VOICE_KEY ?? "";
const NICK = "stv.tf ● recording";
const DEFAULT_DELAY = 90,
  MAX_DELAY = 300;

if (!process.env.DISCORD_TOKEN || !KEY) {
  console.error("stvtf-voice-bot: set DISCORD_TOKEN and STVTF_VOICE_KEY");
  process.exit(2);
}

const delayOption = (/** @type {import("discord.js").SlashCommandNumberOption} */ o) =>
  o
    .setName("delay")
    .setDescription(`Seconds the match's SourceTV is behind the game (tv_delay): ${DEFAULT_DELAY} unless said; 0 for live commentary`)
    .setMinValue(0)
    .setMaxValue(MAX_DELAY);

const command = new SlashCommandBuilder()
  .setName("stv")
  .setDescription("Your voice channel's comms in a match on stv.tf")
  .addSubcommand(s =>
    s
      .setName("join")
      .setDescription("Join your voice channel and pass what is said to a match on stv.tf")
      .addStringOption(o => o.setName("link").setDescription("The match's or room's page on stv.tf").setRequired(true))
      .addNumberOption(delayOption),
  )
  .addSubcommand(s => s.setName("leave").setDescription("Leave the voice channel"))
  .addSubcommand(s => s.setName("delay").setDescription("Change the delay as it goes").addNumberOption(o => delayOption(o).setRequired(true)))
  .addSubcommand(s => s.setName("link").setDescription("Link your Steam account, so your voice is your player's"));

/** @type {Map<string, Channel>} The channel the bot is in, by server. */
const channels = new Map();
/** @type {Set<string>} Servers the bot is on its way into a channel of. */
const joining = new Set();
/** @type {Map<string, Who>} By stv.tf origin. */
const whos = new Map();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

client.once("clientReady", async () => {
  await client.application?.commands.set([command.toJSON()]);
  console.log(`stvtf-voice-bot: ready as ${client.user?.tag}, for ${HOSTS.join(", ")}`);
});

/** @param {import("discord.js").ChatInputCommandInteraction} i @param {string} content */
const reply = (i, content) => i.reply({ content, flags: MessageFlags.Ephemeral });

/** @param {import("discord.js").ChatInputCommandInteraction} i */
async function join(i) {
  const member = await i.guild?.members.fetch(i.user.id);
  const voice = member?.voice.channel;
  if (!voice || !i.guild) return reply(i, "Join a voice channel first: I come to the one you are in.");
  if (channels.has(i.guild.id) || joining.has(i.guild.id))
    return reply(i, "I am already in a channel on this server: `/stv leave` first.");
  const match = matchOf(i.options.getString("link", true), HOSTS);
  if (!match) return reply(i, `That is not a match or room page on ${HOSTS[0]}.`);
  const delay = i.options.getNumber("delay") ?? DEFAULT_DELAY;
  // Held from here on: a second join meanwhile is told so.
  joining.add(i.guild.id);
  await i.deferReply();
  const origin = new URL(match.who).origin;
  let who = whos.get(origin);
  if (!who) whos.set(origin, (who = new Who({ url: match.who, key: KEY })));
  const guildId = i.guild.id;
  const channel = new Channel({
    channel: voice,
    match,
    delay,
    key: KEY,
    who,
    onGone: why => {
      channels.delete(guildId);
      i.guild?.members.me?.setNickname(null).catch(() => {});
      if (voice.type === ChannelType.GuildVoice) voice.send(`I have left: ${why}`).catch(() => {});
    },
  });
  try {
    await channel.join();
  } catch {
    joining.delete(guildId);
    channel.leave("I could not join the channel.");
    return i.editReply("I could not join that channel (may I connect to it?).");
  }
  channels.set(guildId, channel);
  joining.delete(guildId);
  i.guild.members.me?.setNickname(NICK).catch(() => {});
  const unlinked = await channel.unlinked();
  const how = delay ? `${delay} s behind, with the match's SourceTV` : "live, as commentary";
  await i.editReply(
    [
      `🔴 **Recording this channel** for ${match.page}: what is said here is heard there by everyone watching, ${how}.`,
      unlinked.length ? `Not linked to Steam yet (heard, but not as their player): ${unlinked.join(", ")}. Use \`/stv link\`.` : "",
      "`/stv leave` stops it.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

const NOT_IN = "Only those in the voice channel I am in do that.";

/**
 * Whether whoever gave the command is in the voice channel the bot is in.
 * @param {import("discord.js").ChatInputCommandInteraction} i @param {Channel} here
 */
async function inChannel(i, here) {
  const member = await i.guild?.members.fetch(i.user.id);
  return mayControl(member?.voice.channelId, here.channel.id);
}

client.on("interactionCreate", async i => {
  if (!i.isChatInputCommand() || i.commandName !== "stv") return;
  const here = i.guild ? channels.get(i.guild.id) : undefined;
  try {
    switch (i.options.getSubcommand()) {
      case "join":
        return await join(i);
      case "leave":
        if (!here) return await reply(i, "I am not in a channel here.");
        if (!(await inChannel(i, here))) return await reply(i, NOT_IN);
        here.leave(`${i.user.displayName} asked me to.`);
        return await reply(i, "Left.");
      case "delay": {
        if (!here) return await reply(i, "I am not in a channel here.");
        if (!(await inChannel(i, here))) return await reply(i, NOT_IN);
        here.forwarder.delay = i.options.getNumber("delay", true);
        const said = `${i.user.displayName} set the delay to ${here.forwarder.delay} s from now on${here.forwarder.delay ? "" : ": what is said here is heard **live**"}.`;
        // Told where it is recorded, wherever the command was given.
        if (here.channel.type === ChannelType.GuildVoice && i.channelId !== here.channel.id) here.channel.send(said).catch(() => {});
        return await i.reply(said);
      }
      case "link":
        return await reply(i, `Link your Steam account (through the one on your Discord profile): ${homeOf(HOSTS)}/voice/link`);
    }
  } catch (e) {
    console.error("stvtf-voice-bot:", e);
  }
});

// The channel emptied of people: nothing left to pass on.
client.on("voiceStateUpdate", old => {
  const here = channels.get(old.guild.id);
  if (here && !here.hasPeople()) here.leave("everyone left.");
});

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    for (const c of channels.values()) c.leave("I am being restarted.");
    await client.destroy();
    process.exit(0);
  });

client.login(process.env.DISCORD_TOKEN);
