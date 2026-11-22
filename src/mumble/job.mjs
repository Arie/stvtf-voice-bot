// A Mumble channel stv.tf wants the bot in, and what is derived from it: the channel id its
// voice is reported under, and the name the bot signs in with.

/**
 * A channel wanted, as stv.tf sends it: `job` says which of the match's channels it is.
 * @typedef {{ match: string; invite: string; host: string; port: number; password: string; channel: string; delay: number; asked?: number; job?: number }} Wanted
 */
/** A channel wanted, with where its voice goes; `slot` is the `job` field stv.tf sends. @typedef {Omit<Wanted, "job"> & { slot?: number; voice: string; page: string }} Job */

/** The channel id a job's voice is reported under to stv.tf. @param {Job} j */
export const channelOf = j => `mumble:${j.host}:${j.channel.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60)}`;

/** Whether stv.tf's answer holds a job the bot can do. @param {unknown} j @returns {j is Wanted} */
export const isJob = j => {
  if (j === null || typeof j !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (j);
  return ["match", "host", "channel"].every(k => typeof o[k] === "string" && o[k]) && Number.isInteger(o.port);
};

/**
 * The name the bot signs in with for a job, different for each match and channel. A server lets
 * a second client with the same name in by kicking the first, so two channels, or two matches on
 * one server, must not share a name. Hyphens join its parts: most servers allow no space in a name.
 * @param {Job} job
 */
export const nameOf = job => `stv.tf-${job.match.slice(0, 6)}${(job.slot ?? 1) > 1 ? `-${job.slot}` : ""}`;
