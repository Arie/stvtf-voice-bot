// The certificates the bot signs in to Mumble servers by: one per bot on a server at once, the
// same every time, listed at `PAGE`.
import { X509Certificate, createPrivateKey } from "node:crypto";

/** Where they are listed. */
export const PAGE = "https://stv.tf/mumble";

/** A certificate, its key (PEM) and its name (CN). @typedef {{ cert: string; key: string; name: string }} Identity */

/** @param {string} pem @param {string} what */
const blocks = (pem, what) =>
  pem.match(new RegExp(`-----BEGIN ${what}-----[\\s\\S]*?-----END ${what}-----`, "g")) ?? [];

/**
 * `bundle`: base64 of certificates, then their keys (PEM), in the same order.
 * @param {string} bundle @returns {Identity[]}
 * @throws {Error} For keys that are not those certificates'.
 */
export function identitiesOf(bundle) {
  const pem = Buffer.from(bundle, "base64").toString("latin1");
  const certs = blocks(pem, "CERTIFICATE"),
    keys = blocks(pem, "(?:RSA |EC )?PRIVATE KEY");
  if (!certs.length || certs.length !== keys.length) throw new Error("as many keys as certificates, and one at least");
  return certs.map((cert, i) => {
    const x = new X509Certificate(cert);
    if (!x.checkPrivateKey(createPrivateKey(keys[i]))) throw new Error(`key ${i + 1} is not certificate ${i + 1}'s`);
    const name = /^CN=(.+)$/m.exec(x.subject)?.[1];
    if (!name) throw new Error(`certificate ${i + 1} has no name`);
    return { cert, key: keys[i], name };
  });
}

/** Each identity on a server once at a time. */
export class Identities {
  /** @type {Map<string, Set<number>>} By server: which are there. */
  #taken = new Map();

  /** @param {Identity[]} all */
  constructor(all) {
    this.all = all;
  }

  /**
   * The first free on `server` (host:port), until `release`; none when all are taken.
   * @param {string} server @returns {(Identity & { release: () => void }) | null}
   */
  take(server) {
    const at = server.toLowerCase();
    const there = this.#taken.get(at) ?? new Set();
    const n = this.all.findIndex((_, i) => !there.has(i));
    if (n < 0) return null;
    this.#taken.set(at, there.add(n));
    return {
      ...this.all[n],
      release: () => {
        there.delete(n);
        if (!there.size && this.#taken.get(at) === there) this.#taken.delete(at);
      },
    };
  }
}
