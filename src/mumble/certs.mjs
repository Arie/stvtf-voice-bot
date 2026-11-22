// The certificates the bot signs in to Mumble servers with. Each connection to one server uses
// a different certificate, and they are the same every time. They are listed at `PAGE`.
import { X509Certificate, createPrivateKey } from "node:crypto";

/** The page that lists the certificates. */
export const PAGE = "https://stv.tf/mumble";

/** A certificate, its key (PEM) and its name (CN). @typedef {{ cert: string; key: string; name: string }} Identity */

/** @param {string} pem @param {string} what */
const blocks = (pem, what) =>
  pem.match(new RegExp(`-----BEGIN ${what}-----[\\s\\S]*?-----END ${what}-----`, "g")) ?? [];

/**
 * `bundle`: base64 of certificates, then their keys (PEM), in the same order.
 * @param {string} bundle @returns {Identity[]}
 * @throws {Error} If a key does not belong to its certificate, the counts differ or a certificate has no name.
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

/** Hands out identities, so that each is in use on a server by one connection at a time. */
export class Identities {
  /** @type {Map<string, Set<number>>} By server: the indexes of the identities in use there. */
  #taken = new Map();

  /** @param {Identity[]} all */
  constructor(all) {
    this.all = all;
  }

  /**
   * The first identity not in use on `server` (address:port), taken until `release` is called;
   * null when all are taken.
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
