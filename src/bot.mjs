// The stv.tf voice bot: it sits in a team's voice channel, in Discord (src/discord) or Mumble
// (src/mumble), says it is recording, and passes what is said to a match on stv.tf. Its settings
// are in src/config.mjs.
import { config } from "./config.mjs";
import { startDiscord } from "./discord/bot.mjs";
import { startMumble } from "./mumble/bot.mjs";
import { stopOnSignal } from "./shutdown.mjs";

// How long the goodbyes in Discord and Mumble may take, all at once, before it exits.
const GOODBYE_MS = 5000;

let settings;
try {
  settings = config(process.env);
} catch (e) {
  console.error(`stvtf-voice-bot: ${/** @type {Error} */ (e).message}`);
  process.exit(2);
}
const { hosts, key, token, anywhere } = settings;

const discord = startDiscord({
  hosts,
  key,
  token,
  onLoginFailed: e => {
    console.error(`stvtf-voice-bot: Discord: ${e.message}`);
    process.exit(1);
  },
});
const mumble = startMumble({ hosts, key, anywhere });

stopOnSignal({ stop: () => Promise.all([mumble.stop("restarting"), discord.stop("restarting")]), ms: GOODBYE_MS });
