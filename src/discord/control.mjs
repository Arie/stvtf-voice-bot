// Who may change what the bot does in a voice channel: those in it. Its voice is theirs, and a
// delay of none sends it out live.

/**
 * @param {string | null | undefined} callerChannel The voice channel the caller is in.
 * @param {string} botChannel The one the bot is in.
 */
export const mayControl = (callerChannel, botChannel) => callerChannel === botChannel;
