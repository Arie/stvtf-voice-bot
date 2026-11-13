import assert from "node:assert/strict";
import { test } from "node:test";
import { postStatus } from "../src/status.mjs";
import { fetchOf } from "./stand.mjs";

test("stv.tf is told how it goes in a channel, and who is in it, with the key and the invite", async () => {
  /** @type {{ url: string; auth: string; body: unknown }[]} */
  const calls = [];
  const fetch = fetchOf(
    async (url, init) => (
      calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) }),
      { ok: true }
    ),
  );
  await postStatus(
    { page: "https://stv.tf/r/abc/", key: "k", invite: "inv", fetch },
    { kind: "discord", status: "In General", people: [{ id: "7", name: "a" }] },
  );
  await postStatus({ page: "https://stv.tf/r/abc/", key: "k", invite: "inv", fetch }, { kind: "discord", left: true });
  assert.deepEqual(calls, [
    {
      url: "https://stv.tf/r/abc/voice-status",
      auth: "Bearer k",
      body: { invite: "inv", kind: "discord", status: "In General", people: [{ id: "7", name: "a" }] },
    },
    {
      url: "https://stv.tf/r/abc/voice-status",
      auth: "Bearer k",
      body: { invite: "inv", kind: "discord", left: true },
    },
  ]);
  // stv.tf not answering is no reason to stop.
  await postStatus(
    { page: "p/", key: "k", invite: "i", fetch: fetchOf(async () => Promise.reject(new Error("down"))) },
    { kind: "discord", status: "x" },
  );
});
