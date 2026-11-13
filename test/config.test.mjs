import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../src/config.mjs";

const env = { DISCORD_TOKEN: "t", STVTF_VOICE_KEY: "k" };

test("the four regions unless said otherwise; a Mumble server anywhere only when said so", () => {
  assert.deepEqual(config(env), {
    hosts: ["stv.tf", "na.stv.tf", "au.stv.tf", "sea.stv.tf"],
    key: "k",
    token: "t",
    anywhere: false,
  });
  assert.equal(config({ ...env, STVTF_MUMBLE_ANYWHERE: "1" }).anywhere, true);
});

test("hosts with nothing between their commas are no hosts", () => {
  assert.deepEqual(config({ ...env, STVTF_HOSTS: "localhost:8090, ,stv.tf," }).hosts, ["localhost:8090", "stv.tf"]);
  assert.throws(() => config({ ...env, STVTF_HOSTS: " , " }), /STVTF_HOSTS/);
});

test("no token or key is no bot", () => {
  assert.throws(() => config({ DISCORD_TOKEN: "t" }), /STVTF_VOICE_KEY/);
  assert.throws(() => config({ STVTF_VOICE_KEY: "k" }), /DISCORD_TOKEN/);
});
