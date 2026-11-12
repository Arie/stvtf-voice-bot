// The stv.tf voice bot: it sits in a team's voice channel, in Discord (src/discord) or Mumble
// (src/mumble), says it is recording, and passes what is said to a match on stv.tf.
//
// Environment: DISCORD_TOKEN; STVTF_VOICE_KEY (the key stv.tf takes voice with); STVTF_HOSTS (the
// stv.tf hosts voice may go to, comma separated; default the four regions).
import { startDiscord } from "./discord/bot.mjs";
import { startMumble } from "./mumble/bot.mjs";

const hosts = (process.env.STVTF_HOSTS ?? "stv.tf,na.stv.tf,au.stv.tf,sea.stv.tf").split(",").map(h => h.trim());
const key = process.env.STVTF_VOICE_KEY ?? "";
const token = process.env.DISCORD_TOKEN ?? "";

if (!token || !key) {
  console.error("stvtf-voice-bot: set DISCORD_TOKEN and STVTF_VOICE_KEY");
  process.exit(2);
}

const discord = startDiscord({ hosts, key, token });
const mumble = startMumble({ hosts, key });

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    // Mumble's goodbyes get a moment to go out.
    await Promise.race([mumble.stop("restarting"), new Promise(r => setTimeout(r, 2000))]);
    await discord.stop("restarting");
    process.exit(0);
  });
