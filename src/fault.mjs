// Something that should not have gone wrong: said, and told to Sentry (see instrument.mjs).
import * as Sentry from "@sentry/node";

/** @param {string} what @param {unknown} e */
export function fault(what, e) {
  console.error(`stvtf-voice-bot: ${what}:`, e);
  Sentry.captureException(e, { tags: { what } });
}

/** Sends what is still to be told, in `ms` at most. @param {number} ms */
export const told = ms => Sentry.flush(ms).catch(() => false);
