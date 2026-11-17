import assert from "node:assert/strict";
import { test } from "node:test";
import * as Sentry from "@sentry/node";

process.env.SENTRY_DSN = "https://public@sentry.invalid/1";
await import("../src/instrument.mjs");
const { fault } = await import("../src/fault.mjs");

test("a fault is of the Discord user it went wrong for", async () => {
  /** @type {import("@sentry/node").Event[]} */
  const seen = [];
  Sentry.getGlobalScope().addEventProcessor(e => (seen.push(e), null));
  const said = console.error;
  console.error = () => {};
  try {
    fault("/stv", new Error("broke"), "1234");
    fault("Discord", new Error("broke"));
    await Sentry.flush(1000);
  } finally {
    console.error = said;
  }
  const of = (/** @type {string} */ what) => seen.find(e => e.tags?.what === what);
  assert.equal(of("/stv")?.user?.id, "1234");
  assert.ok(of("Discord"));
  assert.equal(of("Discord")?.user, undefined);
});
