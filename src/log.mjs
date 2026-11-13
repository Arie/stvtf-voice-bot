// What the bot logs: a line when what it says of something changes, not each time it is so again.

/**
 * A log of one thing (a channel, a stv.tf): a line is printed once, until another comes. Numbers
 * at a line's end (a count, a tick) do not make it another.
 * @param {string} where @param {(line: string) => void} [print]
 */
export function logOf(where, print = line => console.log(line)) {
  let last = "";
  return (/** @type {string} */ text) => {
    const kind = text.replace(/\d+$/, "");
    if (kind === last) return;
    last = kind;
    print(`stvtf-voice-bot: ${where}: ${text}`);
  };
}
