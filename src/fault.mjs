// An unexpected error: printed, and reported to Sentry (see instrument.mjs).
import * as Sentry from "@sentry/node";

/** `who`: the Discord id of the user it went wrong for. @param {string} what @param {unknown} e @param {string} [who] */
export function fault(what, e, who) {
  console.error(`stvtf-voice-bot: ${what}:`, e);
  Sentry.captureException(e, { tags: { what }, ...(who && { user: { id: who } }) });
}

/** Sends the reports Sentry has not sent yet, waiting `ms` at most. @param {number} ms */
export const told = ms => Sentry.flush(ms).catch(() => false);
