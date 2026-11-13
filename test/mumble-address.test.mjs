import assert from "node:assert/strict";
import { test } from "node:test";
import { addressOf, isPublic } from "../src/mumble/address.mjs";
import { lookupOf } from "./fake-mumble.mjs";

test("only servers out on the internet are joined", () => {
  for (const ip of ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]) assert.equal(isPublic(ip), true, ip);
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "192.168.1.12",
    "172.16.0.1",
    "169.254.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:10.0.0.1",
  ])
    assert.equal(isPublic(ip), false, ip);
});

test("nor any range that leads back in: benchmarking, IETF, NAT64, 6to4, IPv4 in IPv6 however written", () => {
  for (const ip of [
    "198.18.0.1",
    "198.19.255.1",
    "192.0.0.8",
    "64:ff9b::a00:1",
    "64:ff9b::808:808",
    "2002:a00:1::1",
    "::ffff:a00:1",
    "::ffff:127.0.0.1",
    "0:0:0:0:0:ffff:7f00:1",
    "::127.0.0.1",
    "::",
  ])
    assert.equal(isPublic(ip), false, ip);
  for (const ip of ["198.20.0.1", "192.0.1.1", "::ffff:8.8.8.8", "2001:4860:4860::8888"])
    assert.equal(isPublic(ip), true, ip);
});

test("a server is joined at an address checked, every one of its addresses public", async () => {
  assert.equal(
    await addressOf("mumble.example", { lookup: lookupOf(["93.184.216.34", "2606:2800:220:1::1"]) }),
    "93.184.216.34",
  );
  await assert.rejects(
    addressOf("mumble.example", { lookup: lookupOf(["93.184.216.34", "10.0.0.1"]) }),
    /private address/,
  );
  await assert.rejects(addressOf("mumble.example", { lookup: lookupOf(["::1", "93.184.216.34"]) }), /private address/);
  await assert.rejects(addressOf("mumble.example", { lookup: lookupOf([]) }), /no address/);
  assert.equal(
    await addressOf("mumble.example", { lookup: lookupOf(["10.0.0.1"]), anywhere: true }),
    "10.0.0.1",
    "when said so, for trying out",
  );
});
