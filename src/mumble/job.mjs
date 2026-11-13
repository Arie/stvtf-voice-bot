// A Mumble channel stv.tf wants the bot in, and what follows from it: the channel its voice is
// said to come from, and the name the bot signs in by.

/**
 * A channel wanted, as stv.tf sends it: `job` says which of the match's channels it is.
 * @typedef {{ match: string; invite: string; host: string; port: number; password: string; channel: string; delay: number; asked?: number; job?: number }} Wanted
 */
/** A channel wanted, with where its voice goes; `slot` is the wire's `job`. @typedef {Omit<Wanted, "job"> & { slot?: number; voice: string; page: string }} Job */

/** The channel a job's voice is said to come from, to stv.tf. @param {Job} j */
export const channelOf = j => `mumble:${j.host}:${j.channel.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60)}`;

/** Whether stv.tf's answer holds a job the bot can do. @param {unknown} j @returns {j is Wanted} */
export const isJob = j => {
  if (j === null || typeof j !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (j);
  return ["match", "host", "channel"].every(k => typeof o[k] === "string" && o[k]) && Number.isInteger(o.port);
};

/**
 * The name the bot signs in by for a job: its match's and channel's own. A server lets a second
 * of one name in by putting the first out, so two channels, or two matches on one server, must
 * not share one. Hyphens join its parts: most servers allow no space in a name.
 * @param {Job} job
 */
export const nameOf = job => `stv.tf-${job.match.slice(0, 6)}${(job.slot ?? 1) > 1 ? `-${job.slot}` : ""}`;
