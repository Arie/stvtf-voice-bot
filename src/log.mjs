// The bot's log: a line is printed when a status changes, not each time the same status repeats.

/**
 * A log for one subject (a channel, a stv.tf host). A line is not printed again until a
 * different line has come. A number at the end of a line (a count, a tick) does not make it
 * different.
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
