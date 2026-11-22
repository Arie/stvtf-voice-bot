// Reports errors to Sentry (SENTRY_DSN; without a DSN nothing is sent), with the version Kamal
// runs as the release. Loaded before the bot (node --import), so an error in any module is seen.
// Only the error and its stack are sent: not what the bot prints, sends or holds in its
// variables, because those name channels and people.
import * as Sentry from "@sentry/node";

Sentry.init({
  release: process.env.SENTRY_RELEASE ?? process.env.KAMAL_VERSION,
  integrations: all => all.filter(i => i.name !== "Console"),
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    stackFrameVariables: false,
  },
});

// The SDK sends its trace to stv.tf (the `sentry-trace` header), which continues it. So each
// request gets a trace of its own, instead of one trace for the whole process.
const fetched = globalThis.fetch;
globalThis.fetch = (...args) => Sentry.startNewTrace(() => fetched(...args));
