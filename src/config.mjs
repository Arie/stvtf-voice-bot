// The bot's settings, from its environment: DISCORD_TOKEN; STVTF_VOICE_KEY (the key stv.tf takes
// voice with); STVTF_HOSTS (the stv.tf hosts voice may go to, comma separated; default the four
// regions); STVTF_MUMBLE_ANYWHERE=1 (a Mumble server may be on this machine or its network: for
// trying out, and at a LAN); STVTF_STATE (a file to keep the Discord channels it is in, to go back
// into them after a restart; without, it goes back into none); STVTF_MUMBLE_CERTS (its Mumble
// certificates, see src/mumble/certs.mjs).
import { identitiesOf } from "./mumble/certs.mjs";

const HOSTS = "stv.tf,na.stv.tf,au.stv.tf,sea.stv.tf";

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ hosts: string[]; key: string; token: string; anywhere: boolean; state: string | null; certs: import("./mumble/certs.mjs").Identity[] }}
 * @throws {Error} Saying what is missing.
 */
export function config(env) {
  const key = env.STVTF_VOICE_KEY ?? "";
  const token = env.DISCORD_TOKEN ?? "";
  if (!token || !key) throw new Error("set DISCORD_TOKEN and STVTF_VOICE_KEY");
  const hosts = (env.STVTF_HOSTS ?? HOSTS)
    .split(",")
    .map(h => h.trim())
    .filter(Boolean);
  if (!hosts.length) throw new Error("set STVTF_HOSTS");
  let certs;
  try {
    certs = env.STVTF_MUMBLE_CERTS ? identitiesOf(env.STVTF_MUMBLE_CERTS) : [];
  } catch (e) {
    throw new Error(`STVTF_MUMBLE_CERTS: ${/** @type {Error} */ (e).message}`, { cause: e });
  }
  return { hosts, key, token, anywhere: env.STVTF_MUMBLE_ANYWHERE === "1", state: env.STVTF_STATE || null, certs };
}
