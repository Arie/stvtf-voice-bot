// The stv.tf voice bot: `/stv join` brings it into the caller's voice channel, where it says it
// is recording and passes what is said to the match on stv.tf the link names, as the speakers'
// players (their Steam accounts, linked through Discord on stv.tf). One channel per server.
//
// Environment: DISCORD_TOKEN; STVTF_VOICE_KEY (the key stv.tf takes voice with); STVTF_HOSTS (the
// stv.tf hosts voice may go to, comma separated; default the four regions).
import { ChannelType, Client, GatewayIntentBits, SlashCommandBuilder } from "discord.js";
import { Channel } from "./channel.mjs";
import { join as joinChannel, reply, said as quiet } from "./join.mjs";
import { homeOf } from "./match.mjs";
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
    .setDescription(`tv_delay in seconds (default ${DEFAULT_DELAY}; 0 = instant)`)
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

// Unheard, an error would end the process; the client reconnects by itself.
client.on("error", e => console.error("stvtf-voice-bot:", e));

client.once("clientReady", async () => {
  await client.application?.commands.set([command.toJSON()]).catch(e => console.error("stvtf-voice-bot: commands not set:", e));
  console.log(`stvtf-voice-bot: ready as ${client.user?.tag}, for ${HOSTS.join(", ")}`);
});

/** @param {string} url Where to ask who someone is: one Who for each stv.tf. */
const whoFor = url => {
  const origin = new URL(url).origin;
  let who = whos.get(origin);
  if (!who) whos.set(origin, (who = new Who({ url, key: KEY })));
  return who;
};

/** @param {import("discord.js").ChatInputCommandInteraction} i */
const join = i =>
  joinChannel(i, { hosts: HOSTS, key: KEY, nick: NICK, defaultDelay: DEFAULT_DELAY, channels, joining, whoFor, makeChannel: o => new Channel(o) });

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
        if (here.channel.type === ChannelType.GuildVoice && i.channelId !== here.channel.id) here.channel.send(quiet(said)).catch(() => {});
        return await i.reply(quiet(said));
      }
      case "link":
        return await reply(i, `Link Steam: ${homeOf(HOSTS)}/voice/link`);
    }
  } catch (e) {
    console.error("stvtf-voice-bot:", e);
  }
});

// Someone came or went, or the bot was moved.
client.on("voiceStateUpdate", (old, now) => channels.get(old.guild.id)?.update(old, now));

// Mumble: every stv.tf says which channels it wants the bot in (asked for on a match's page).
const mumble = HOSTS.map(host => new Jobs({ origin: homeOf([host]), key: KEY, start: (job, status) => startSession(job, status, { key: KEY }) }));
for (const jobs of mumble) jobs.run();

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    for (const c of channels.values()) c.leave("restarting");
    // Mumble's goodbyes get a moment to go out.
    await Promise.race([Promise.all(mumble.map(jobs => jobs.stop("restarting"))), new Promise(r => setTimeout(r, 2000))]);
    await client.destroy();
    process.exit(0);
  });

client.login(process.env.DISCORD_TOKEN);
