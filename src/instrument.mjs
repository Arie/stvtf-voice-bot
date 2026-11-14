// What goes wrong is told to Sentry (SENTRY_DSN, as the version Kamal runs; without a DSN nothing
// is sent). Loaded before the bot (node --import), so an error of any module is seen. Only the
// error and its stack: not what the bot prints, nor what it sends or holds in its variables,
// which name channels and people.
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
