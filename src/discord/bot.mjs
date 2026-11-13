// The bot in Discord: `/stv join` brings it into the caller's voice channel, where it says it is
// recording and passes what is said to the match on stv.tf the link names, as the speakers'
// players (their Steam accounts, linked through Discord on stv.tf). One channel per server.
import { ChannelType, Client, GatewayIntentBits, SlashCommandBuilder } from "discord.js";
import { homeOf } from "../match.mjs";
import { Channel } from "./channel.mjs";
import { mayControl } from "./control.mjs";
import { joinCommand, noMentions, reply } from "./join.mjs";
import { Who } from "./who.mjs";

const NICK = "stv.tf ● recording";
const DEFAULT_DELAY = 90,
  MAX_DELAY = 300;

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

const NOT_IN = "Join my voice channel first.";

/**
 * Whether whoever gave the command is in the voice channel the bot is in.
 * @param {import("discord.js").ChatInputCommandInteraction} i @param {Channel} here
 */
async function inChannel(i, here) {
  const member = await i.guild?.members.fetch(i.user.id);
  return mayControl(member?.voice.channelId, here.channel.id);
}

/**
 * `/stv leave` and `/stv delay`: for those in the bot's channel only.
 * @param {import("discord.js").ChatInputCommandInteraction} i @param {Channel | undefined} here
 */
async function control(i, here) {
  if (!here) return reply(i, "Not in a channel.");
  if (!(await inChannel(i, here))) return reply(i, NOT_IN);
  if (i.options.getSubcommand() === "leave") {
    here.leave(`/stv leave by ${i.user.displayName}`);
    return reply(i, "Left.");
  }
  here.forwarder.delay = i.options.getNumber("delay", true);
  const text = `tv_delay: ${here.forwarder.delay} s${here.forwarder.delay ? "" : " (live)"}`;
  // Told where it is recorded, wherever the command was given.
  if (here.channel.type === ChannelType.GuildVoice && i.channelId !== here.channel.id)
    here.channel.send(noMentions(text)).catch(() => {});
  return i.reply(noMentions(text));
}

/**
 * Signs in to Discord with `token` and takes `/stv` commands, for matches on `hosts` (voice goes
 * there with `key`). Its `stop` leaves every channel and signs out.
 * @param {{ hosts: string[]; key: string; token: string }} o
 * @returns {{ stop: (why: string) => Promise<void> }}
 */
export function startDiscord({ hosts, key, token }) {
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
    await client.application?.commands
      .set([command.toJSON()])
      .catch(e => console.error("stvtf-voice-bot: commands not set:", e));
    console.log(`stvtf-voice-bot: ready as ${client.user?.tag}, for ${hosts.join(", ")}`);
  });

  /** @param {string} url Where to ask who someone is: one Who for each stv.tf. */
  const whoFor = url => {
    const origin = new URL(url).origin;
    let who = whos.get(origin);
    if (!who) whos.set(origin, (who = new Who({ url, key })));
    return who;
  };

  /** @type {Parameters<typeof joinCommand>[1]} */
  const joinOptions = {
    hosts,
    key,
    nick: NICK,
    defaultDelay: DEFAULT_DELAY,
    channels,
    joining,
    whoFor,
    makeChannel: o => new Channel(o),
  };

  client.on("interactionCreate", async i => {
    if (!i.isChatInputCommand() || i.commandName !== "stv") return;
    const here = i.guild ? channels.get(i.guild.id) : undefined;
    try {
      switch (i.options.getSubcommand()) {
        case "join":
          return await joinCommand(i, joinOptions);
        case "leave":
        case "delay":
          return await control(i, here);
        case "link":
          return await reply(i, `Link Steam: ${homeOf(hosts)}/voice/link`);
      }
    } catch (e) {
      console.error("stvtf-voice-bot:", e);
    }
  });

  // Someone came or went, or the bot was moved.
  client.on("voiceStateUpdate", (old, now) => channels.get(old.guild.id)?.update(old, now));

  client.login(token);
  return {
    stop: async why => {
      for (const c of channels.values()) c.leave(why);
      await client.destroy();
    },
  };
}
