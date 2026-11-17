import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

process.env.SENTRY_DSN = "https://public@sentry.invalid/1";
await import("../src/instrument.mjs");

test("each request to stv.tf carries a trace of its own", async () => {
  /** @type {string[]} */
  const traces = [];
  const server = http.createServer((q, r) => {
    traces.push(String(q.headers["sentry-trace"] ?? ""));
    r.end();
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  try {
    for (let i = 0; i < 2; i++) await (await fetch(`http://127.0.0.1:${port}/`)).text();
  } finally {
    server.close();
  }
  const ids = traces.map(t => t.split("-")[0]);
  assert.equal(ids.length, 2);
  assert.match(ids[0], /^[0-9a-f]{32}$/);
  assert.notEqual(ids[0], ids[1]);
});
