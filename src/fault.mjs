// Something that should not have gone wrong: said, and told to Sentry (see instrument.mjs).
import * as Sentry from "@sentry/node";

/** `who`: the Discord id of whom it went wrong for. @param {string} what @param {unknown} e @param {string} [who] */
export function fault(what, e, who) {
  console.error(`stvtf-voice-bot: ${what}:`, e);
  Sentry.captureException(e, { tags: { what }, ...(who && { user: { id: who } }) });
}

/** Sends what is still to be told, in `ms` at most. @param {number} ms */
export const told = ms => Sentry.flush(ms).catch(() => false);
