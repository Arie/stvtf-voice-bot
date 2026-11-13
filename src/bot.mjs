// The stv.tf voice bot: it sits in a team's voice channel, in Discord (src/discord) or Mumble
// (src/mumble), says it is recording, and passes what is said to a match on stv.tf. Its settings
// are in src/config.mjs.
import { config } from "./config.mjs";
import { startDiscord } from "./discord/bot.mjs";
import { startMumble } from "./mumble/bot.mjs";

let settings;
try {
  settings = config(process.env);
} catch (e) {
  console.error(`stvtf-voice-bot: ${/** @type {Error} */ (e).message}`);
  process.exit(2);
}
const { hosts, key, token, anywhere } = settings;

const discord = startDiscord({ hosts, key, token });
const mumble = startMumble({ hosts, key, anywhere });

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    // Mumble's goodbyes get a moment to go out.
    await Promise.race([mumble.stop("restarting"), new Promise(r => setTimeout(r, 2000))]);
    await discord.stop("restarting");
    process.exit(0);
  });
