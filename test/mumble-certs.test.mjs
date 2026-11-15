import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { config } from "../src/config.mjs";
import { Identities, identitiesOf } from "../src/mumble/certs.mjs";

// Two test certificates with their keys; and with the keys swapped.
const bundle = readFileSync(new URL("fixtures/mumble-certs.b64", import.meta.url), "utf8");
const crossed = readFileSync(new URL("fixtures/mumble-certs-crossed.b64", import.meta.url), "utf8");

test("a bundle is its certificates, each with its key and the name it signs in by", () => {
  const all = identitiesOf(bundle);
  assert.deepEqual(
    all.map(i => i.name),
    ["stv.tf", "stv.tf-2"],
  );
  assert.ok(all.every(i => i.cert.includes("BEGIN CERTIFICATE") && i.key.includes("PRIVATE KEY")));
  assert.equal(config({ DISCORD_TOKEN: "t", STVTF_VOICE_KEY: "k", STVTF_MUMBLE_CERTS: bundle }).certs.length, 2);
});

test("keys that are not the certificates', or too few of them, are no bundle", () => {
  assert.throws(() => identitiesOf(crossed), /key 1 is not certificate 1's/);
  assert.throws(() => identitiesOf(Buffer.from("nothing").toString("base64")), /one at least/);
  assert.throws(
    () => config({ DISCORD_TOKEN: "t", STVTF_VOICE_KEY: "k", STVTF_MUMBLE_CERTS: crossed }),
    /STVTF_MUMBLE_CERTS/,
  );
});

test("a server has each certificate once at a time, the first that is free; another server its own", () => {
  const ids = new Identities(identitiesOf(bundle));
  const [a, b] = [ids.take("Mumble.example:64738"), ids.take("mumble.example:64738")];
  assert.deepEqual([a?.name, b?.name], ["stv.tf", "stv.tf-2"]);
  assert.equal(ids.take("mumble.example:64738"), null, "all there");
  assert.equal(ids.take("mumble.example:1")?.name, "stv.tf", "another server");
  a?.release();
  a?.release();
  assert.equal(ids.take("mumble.example:64738")?.name, "stv.tf", "free again");
});
