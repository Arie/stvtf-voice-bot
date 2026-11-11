import assert from "node:assert/strict";
import { test } from "node:test";
import { homeOf, matchOf } from "../src/match.mjs";

const hosts = ["stv.tf", "na.stv.tf"];

test("a match or room link on a known stv.tf names where voice goes", () => {
  assert.deepEqual(matchOf("https://stv.tf/w/938502c33a83e5e5b9112d801cf6dd8f/", hosts), {
    voice: "https://stv.tf/w/938502c33a83e5e5b9112d801cf6dd8f/voice",
    who: "https://stv.tf/voice/who",
    page: "https://stv.tf/w/938502c33a83e5e5b9112d801cf6dd8f/",
  });
  const room = matchOf("https://na.stv.tf/r/2a691c2acaaf7c67dc3a3d48b0d2b66b/?t=12:00", hosts);
  assert.equal(room?.voice, "https://na.stv.tf/r/2a691c2acaaf7c67dc3a3d48b0d2b66b/voice");
  assert.equal(matchOf("na.stv.tf/w/abc123/overlay", hosts)?.page, "https://na.stv.tf/w/abc123/", "without https, with more after");
});

test("the key never goes anywhere else", () => {
  for (const link of ["https://evil.example/w/abc/", "https://stv.tf.evil.example/w/abc/", "https://stv.tf/x/abc/", "not a link", ""])
    assert.equal(matchOf(link, hosts), null, link);
  assert.equal(matchOf("http://stv.tf/w/abc/", hosts), null, "not without TLS");
  assert.equal(matchOf("http://localhost:8090/w/abc/", ["localhost:8090"])?.voice, "http://localhost:8090/w/abc/voice", "but a local one, for testing");
});

test("who someone is, is asked of the first host, whichever region the match is on", () => {
  assert.equal(homeOf(["stv.tf", "na.stv.tf"]), "https://stv.tf");
  assert.equal(homeOf(["localhost:8090", "stv.tf"]), "http://localhost:8090");
  assert.equal(matchOf("na.stv.tf/w/abc/", ["stv.tf", "na.stv.tf"])?.who, "https://stv.tf/voice/who");
});

test("a local link without http is plain http: a local stv.tf has no https", () => {
  assert.equal(matchOf("localhost:8090/w/abc/", ["localhost:8090"])?.voice, "http://localhost:8090/w/abc/voice");
  assert.equal(matchOf("stv.tf/w/abc/", ["stv.tf"])?.voice, "https://stv.tf/w/abc/voice");
});
