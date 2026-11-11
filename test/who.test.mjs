import assert from "node:assert/strict";
import { test } from "node:test";
import { Who } from "../src/who.mjs";
import { fetchOf } from "./stand.mjs";

test("a linked Discord user is their SteamID, asked once", async () => {
  let asked = 0;
  const fetch = fetchOf(async (url, init) => {
    asked++;
    assert.equal(url, "https://stv.tf/voice/who?discord=42");
    assert.equal(init.headers.Authorization, "Bearer k");
    return { status: 200, ok: true, json: async () => ({ steamid: "[U:1:5]" }) };
  });
  const who = new Who({ url: "https://stv.tf/voice/who", key: "k", fetch });
  assert.equal(await who.steamid("42"), "[U:1:5]");
  assert.equal(await who.steamid("42"), "[U:1:5]");
  assert.equal(asked, 1);
});

test("an unlinked user is asked about again in a while, as is everyone when the site is down", async () => {
  let now = 0,
    asked = 0,
    status = 404;
  const fetch = fetchOf(async () => {
    asked++;
    if (status === 0) throw new Error("down");
    return { status, ok: status === 200, json: async () => ({ steamid: "[U:1:9]" }) };
  });
  const who = new Who({ url: "u", key: "k", fetch, now: () => now });
  assert.equal(await who.steamid("7"), null);
  assert.equal(await who.steamid("7"), null);
  assert.equal(asked, 1, "not on every frame");
  now += 61_000;
  status = 0;
  assert.equal(await who.steamid("7"), null, "down: unlinked for now");
  now += 61_000;
  status = 200;
  assert.equal(await who.steamid("7"), "[U:1:9]", "linked since");
});

test("asked about by many frames at once, the site is asked once", async () => {
  let asked = 0;
  /** @type {(r: unknown) => void} */
  let answer = () => {};
  const fetch = () => {
    asked++;
    return new Promise(r => (answer = r));
  };
  const who = new Who({ url: "u", key: "k", fetch });
  const all = [who.steamid("7"), who.steamid("7"), who.steamid("7")];
  answer({ status: 200, ok: true, json: async () => ({ steamid: "[U:1:9]" }) });
  assert.deepEqual(await Promise.all(all), ["[U:1:9]", "[U:1:9]", "[U:1:9]"]);
  assert.equal(asked, 1);
});
