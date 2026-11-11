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
import { Jobs } from "./mumble/jobs.mjs";
import { startSession } from "./mumble/session.mjs";

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
    .setDescription(`tv_delay in seconds (default ${DEFAULT_DELAY}; 0 = live)`)
    .setMinValue(0)
    .setMaxValue(MAX_DELAY);

const command = new SlashCommandBuilder()
  .setName("stv")
  .setDescription("Voice comms for stv.tf")
  .addSubcommand(s =>
    s
      .setName("join")
      .setDescription("Record your voice channel for a match")
      .addStringOption(o => o.setName("link").setDescription("Link from stv.tf (Comms → Copy command)").setRequired(true))
      .addNumberOption(delayOption),
  )
  .addSubcommand(s => s.setName("leave").setDescription("Leave the voice channel"))
  .addSubcommand(s => s.setName("delay").setDescription("Change tv_delay").addNumberOption(o => delayOption(o).setRequired(true)))
  .addSubcommand(s => s.setName("link").setDescription("Link your Steam account"));

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
  if (!voice || !i.guild) return reply(i, "Join a voice channel first.");
  if (channels.has(i.guild.id) || joining.has(i.guild.id))
    return reply(i, "Already in a channel. `/stv leave` first.");
  const match = matchOf(i.options.getString("link", true), HOSTS);
  if (!match) return reply(i, "Not a stv.tf link.");
  if (!match.invite)
    return reply(i, "No invite in that link. On the match page: 🔊 → Comms → Copy command.");
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
      if (voice.type === ChannelType.GuildVoice) voice.send(`Left: ${why}`).catch(() => {});
    },
  });
  try {
    await channel.join();
  } catch {
    joining.delete(guildId);
    channel.leave("join failed");
    return i.editReply("Can't join that channel.");
  }
  channels.set(guildId, channel);
  joining.delete(guildId);
  i.guild.members.me?.setNickname(NICK).catch(() => {});
  const unlinked = await channel.unlinked();
  await i.editReply(
    [
      `🔴 **Recording** for ${match.page} (${delay ? `tv_delay ${delay} s` : "live"}). \`/stv leave\` to stop.`,
      unlinked.length ? `Not linked: ${unlinked.join(", ")} (\`/stv link\`)` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

const NOT_IN = "Join my voice channel first.";

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
        if (!here) return await reply(i, "Not in a channel.");
        if (!(await inChannel(i, here))) return await reply(i, NOT_IN);
        here.leave(`/stv leave by ${i.user.displayName}`);
        return await reply(i, "Left.");
      case "delay": {
        if (!here) return await reply(i, "Not in a channel.");
        if (!(await inChannel(i, here))) return await reply(i, NOT_IN);
        here.forwarder.delay = i.options.getNumber("delay", true);
        const said = `tv_delay: ${here.forwarder.delay} s${here.forwarder.delay ? "" : " (live)"}`;
        // Told where it is recorded, wherever the command was given.
        if (here.channel.type === ChannelType.GuildVoice && i.channelId !== here.channel.id) here.channel.send(said).catch(() => {});
        return await i.reply(said);
      }
      case "link":
        return await reply(i, `Link Steam: ${homeOf(HOSTS)}/voice/link`);
    }
  } catch (e) {
    console.error("stvtf-voice-bot:", e);
  }
});

// The channel emptied of people: nothing left to pass on.
client.on("voiceStateUpdate", old => {
  const here = channels.get(old.guild.id);
  if (here && !here.hasPeople()) here.leave("channel empty");
  // Someone came or went: stv.tf hears who is here now.
  else here?.report();
});

// Mumble: every stv.tf says which channels it wants the bot in (asked for on a match's page).
const mumble = HOSTS.map(host => new Jobs({ origin: homeOf([host]), key: KEY, start: (job, status) => startSession(job, status, { key: KEY }) }));
for (const jobs of mumble) jobs.run();

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    for (const c of channels.values()) c.leave("restarting");
    for (const jobs of mumble) jobs.stop("restarting");
    await client.destroy();
    process.exit(0);
  });

client.login(process.env.DISCORD_TOKEN);
