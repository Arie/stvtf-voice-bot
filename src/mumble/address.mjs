// Whether a Mumble server may be joined: only one out on the internet, unless said otherwise
// (for trying out, and at a LAN), so a link on stv.tf cannot point the bot inside its network.
import dns from "node:dns/promises";
import net from "node:net";

/** An IPv6 address (as net.isIPv6 takes it) as its 16 bytes. @param {string} ip */
function ipv6Bytes(ip) {
  // One that ends in IPv4's form: those four bytes as two groups.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  const [a, b, c, d] = v4 ? v4.slice(1).map(Number) : [];
  const text = v4 ? `${ip.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}` : ip;
  const [l, r] = text.split("::");
  const left = l ? l.split(":") : [],
    right = r ? r.split(":") : [];
  const groups = r === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return groups.flatMap(g => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
}

// What is not out on the internet: this machine, its networks, a link's own, multicast and the
// rest of what is set aside; and NAT64 and 6to4, which lead to IPv4 addresses of any kind.
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
 * Whether `ip` is out on the internet: not this machine, its network, or a link's own.
 * @param {string} ip @returns {boolean}
 */
export function isPublic(ip) {
  if (net.isIPv4(ip)) return !INSIDE.check(ip, "ipv4");
  if (!net.isIPv6(ip)) return false;
  const x = ipv6Bytes(ip);
  // IPv4 in IPv6 (mapped, or the old compatible form, :: and ::1 among them): as that address.
  if (x.slice(0, 10).every(n => n === 0)) return x[10] === 255 && x[11] === 255 && isPublic(x.slice(12).join("."));
  return !INSIDE.check(ip, "ipv6");
}

/** @typedef {(host: string, o: { all: true }) => Promise<{ address: string }[]>} Lookup */

/**
 * Where to reach `host`: one of its addresses, once every one is known to be out on the internet
 * (a name can give one public and one private, and a second lookup another); with `anywhere`,
 * any (for trying out, and at a LAN).
 * @param {string} host @param {{ lookup?: Lookup; anywhere?: boolean }} [o]
 */
export async function addressOf(host, { lookup = dns.lookup, anywhere = false } = {}) {
  const all = await lookup(host, { all: true });
  if (!all.length) throw new Error("no address");
  if (!anywhere && !all.every(a => isPublic(a.address))) throw new Error("private address");
  return all[0].address;
}
