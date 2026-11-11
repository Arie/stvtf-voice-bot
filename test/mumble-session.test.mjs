import assert from "node:assert/strict";
import { test } from "node:test";
import { tlsOptions } from "../src/mumble/client.mjs";
import { addressOf } from "../src/mumble/session.mjs";

const lookup = (/** @type {string[]} */ ips) => async (host, o) => (assert.equal(o.all, true), ips.map(address => ({ address, family: address.includes(":") ? 6 : 4 })));

test("a server is joined at an address checked, every one of its addresses public", async () => {
  assert.equal(await addressOf("mumble.example", { lookup: lookup(["93.184.216.34", "2606:2800:220:1::1"]) }), "93.184.216.34");
  await assert.rejects(addressOf("mumble.example", { lookup: lookup(["93.184.216.34", "10.0.0.1"]) }), /private address/);
  await assert.rejects(addressOf("mumble.example", { lookup: lookup(["::1", "93.184.216.34"]) }), /private address/);
  await assert.rejects(addressOf("mumble.example", { lookup: lookup([]) }), /no address/);
  assert.equal(await addressOf("mumble.example", { lookup: lookup(["10.0.0.1"]), anywhere: true }), "10.0.0.1", "when said so, for trying out");
});

test("the connection goes to that address, its name the server's for TLS", () => {
  assert.deepEqual(tlsOptions({ host: "mumble.example", address: "93.184.216.34", port: 1 }), {
    host: "93.184.216.34", port: 1, servername: "mumble.example", rejectUnauthorized: false, cert: undefined, key: undefined,
  });
  assert.equal(tlsOptions({ host: "93.184.216.34", address: "93.184.216.34" }).servername, undefined, "no name for an address");
});
