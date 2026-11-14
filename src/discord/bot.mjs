// The bot in Discord: `/stv join` brings it into the caller's voice channel, where it says it is
// recording and passes what is said to the match on stv.tf the link names, as the speakers'
// players (their Steam accounts, linked through Discord on stv.tf). One channel per server.
import { Client, GatewayIntentBits } from "discord.js";
import { fault } from "../fault.mjs";
import { homeOf } from "../match.mjs";
import { DEFAULT_DELAY, command, delayCommand, leaveCommand } from "./commands.mjs";
import { joinCommand, rejoin } from "./join.mjs";
import { Kept } from "./kept.mjs";
import { reply } from "./messages.mjs";
import { DiscordSession } from "./session.mjs";
import { Who } from "./who.mjs";

const NICK = "stv.tf ● recording";

/**
 * Where to ask who someone is, by the URL to ask at: one Who for each stv.tf.
 * @param {string} key @returns {(url: string) => Who}
 */
function whoCache(key) {
  /** @type {Map<string, Who>} By stv.tf origin. */
  const whos = new Map();
  return url => {
    const origin = new URL(url).origin;
    let who = whos.get(origin);
    if (!who) whos.set(origin, (who = new Who({ url, key })));
    return who;
  };
}

/**
 * A `/stv` command, whichever it is.
 * @param {import("discord.js").ChatInputCommandInteraction} i
 * @param {Parameters<typeof joinCommand>[1]} o @param {Map<string, DiscordSession>} sessions
 */
async function onCommand(i, o, sessions) {
  const session = i.guild ? sessions.get(i.guild.id) : undefined;
  switch (i.options.getSubcommand()) {
    case "join":
      return joinCommand(i, o);
    case "leave":
      return leaveCommand(i, session);
    case "delay":
      await delayCommand(i, session);
      if (i.guild && session) o.kept.setDelay(i.guild.id, session.delay);
      return;
    case "link":
      return reply(i, `Link Steam: ${homeOf(o.hosts)}/voice/link`);
  }
}

const newClient = () => new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

/**
 * Signs in to Discord with `token` and takes `/stv` commands, for matches on `hosts` (voice goes
 * there with `key`); `onLoginFailed` is told if Discord will not have the token. Its `stop` leaves
 * every channel, saying nothing there (it goes back into them when started again), and signs out.
 * @param {{ hosts: string[]; key: string; token: string; state?: string | null; onLoginFailed: (e: Error) => void; client?: Client }} o
 *   `state`: the file the channels it is in are kept in, to go back into after a restart;
 *   `client` is for tests.
 * @returns {{ stop: (why: string) => Promise<void> }}
 */
export function startDiscord({ hosts, key, token, state = null, onLoginFailed, client = newClient() }) {
  const kept = new Kept(state);
  /** @type {Map<string, DiscordSession>} The bot in a channel, by server. */
  const sessions = new Map();
  /** @type {Parameters<typeof joinCommand>[1]} */
  const joinOptions = {
    hosts,
    key,
    nick: NICK,
    defaultDelay: DEFAULT_DELAY,
    sessions,
    kept,
    // Servers the bot is on its way into a channel of.
    joining: new Set(),
    whoFor: whoCache(key),
    makeSession: o => new DiscordSession(o),
  };

  // Unheard, an error would end the process; the client reconnects by itself.
  client.on("error", e => fault("Discord", e));

  client.once("clientReady", async () => {
    await client.application?.commands.set([command.toJSON()]).catch(e => fault("commands not set", e));
    console.log(`stvtf-voice-bot: ready as ${client.user?.tag}, for ${hosts.join(", ")}`);
    // Back into the channels it was in when it stopped.
    for (const channel of kept.list()) await rejoin(client, joinOptions, channel);
    if (sessions.size) console.log(`stvtf-voice-bot: back in ${sessions.size} channels`);
  });

  client.on("interactionCreate", async i => {
    if (!i.isChatInputCommand() || i.commandName !== "stv") return;
    await onCommand(i, joinOptions, sessions).catch(e => fault("/stv", e));
  });

  // Someone came or went, or the bot was moved.
  client.on("voiceStateUpdate", (old, now) => sessions.get(old.guild.id)?.update(old, now));

  client.login(token).catch(onLoginFailed);
  return {
    stop: async why => {
      kept.stopping = true;
      await Promise.allSettled([...sessions.values()].map(s => s.leave(why)));
      await client.destroy();
    },
  };
}
