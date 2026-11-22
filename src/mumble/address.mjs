// Decides whether a Mumble server may be joined: only one with a public internet address, unless
// STVTF_MUMBLE_ANYWHERE is set (for testing, and at a LAN). So a request on stv.tf cannot point
// the bot at its own network.
import dns from "node:dns/promises";
import net from "node:net";

/** An IPv6 address (as net.isIPv6 takes it) as its 16 bytes. @param {string} ip */
function ipv6Bytes(ip) {
  // An address that ends in dotted IPv4 form: those four bytes are rewritten as two hex groups.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  const [a, b, c, d] = v4 ? v4.slice(1).map(Number) : [];
  const text = v4 ? `${ip.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}` : ip;
  const [l, r] = text.split("::");
  const left = l ? l.split(":") : [],
    right = r ? r.split(":") : [];
  const groups = r === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return groups.flatMap(g => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
}

// Addresses that are not on the public internet: this machine, private networks, link-local,
// multicast and the other reserved ranges; and NAT64 and 6to4, which can lead to any IPv4 address.
const INSIDE = new net.BlockList();
for (const [ip, bits] of /** @type {[string, number][]} */ ([
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
]))
  INSIDE.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of /** @type {[string, number][]} */ ([
  ["64:ff9b::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]))
  INSIDE.addSubnet(ip, bits, "ipv6");

/**
 * Whether `ip` is a public internet address: not this machine, a private network or link-local.
 * @param {string} ip @returns {boolean}
 */
export function isPublic(ip) {
  if (net.isIPv4(ip)) return !INSIDE.check(ip, "ipv4");
  if (!net.isIPv6(ip)) return false;
  const x = ipv6Bytes(ip);
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged as that IPv4 address. The old IPv4-compatible
  // form (::a.b.c.d, which includes :: and ::1) is never public.
  if (x.slice(0, 10).every(n => n === 0)) return x[10] === 255 && x[11] === 255 && isPublic(x.slice(12).join("."));
  return !INSIDE.check(ip, "ipv6");
}

/** @typedef {(host: string, o: { all: true }) => Promise<{ address: string }[]>} Lookup */

/**
 * The address to reach `host` at: its first one, once all its addresses are known to be public
 * (a name can resolve to one public and one private address, and a second lookup can give
 * another). With `anywhere`, any address is allowed (for testing, and at a LAN).
 * @param {string} host @param {{ lookup?: Lookup; anywhere?: boolean }} [o]
 */
export async function addressOf(host, { lookup = dns.lookup, anywhere = false } = {}) {
  const all = await lookup(host, { all: true });
  if (!all.length) throw new Error("no address");
  if (!anywhere && !all.every(a => isPublic(a.address))) throw new Error("private address");
  return all[0].address;
}
