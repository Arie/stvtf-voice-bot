import assert from "node:assert/strict";
import { test } from "node:test";
import { tell } from "../src/status.mjs";

test("stv.tf is told how it goes in a channel, and who is in it, with the key and the invite", async () => {
  const calls = [];
  const fetch = async (url, init) => (calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) }), { ok: true });
  await tell({ page: "https://stv.tf/r/abc/", key: "k", invite: "inv", fetch }, { kind: "discord", status: "In General", people: [{ id: "7", name: "a" }] });
  await tell({ page: "https://stv.tf/r/abc/", key: "k", invite: "inv", fetch }, { kind: "discord", left: true });
  assert.deepEqual(calls, [
    { url: "https://stv.tf/r/abc/voice-status", auth: "Bearer k", body: { invite: "inv", kind: "discord", status: "In General", people: [{ id: "7", name: "a" }] } },
    { url: "https://stv.tf/r/abc/voice-status", auth: "Bearer k", body: { invite: "inv", kind: "discord", left: true } },
  ]);
  // stv.tf not answering is no reason to stop.
  await tell({ page: "p/", key: "k", invite: "i", fetch: async () => Promise.reject(new Error("down")) }, { kind: "discord", status: "x" });
});
