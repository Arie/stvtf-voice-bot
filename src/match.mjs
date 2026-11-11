// Where a match's voice goes, from a link someone gave: only on the stv.tf hosts we know, so the
// key never goes anywhere else.

const LOCAL = /^(localhost|127\.0\.0\.1)(:\d+)?$/;

// The first host: where people link their Steam account, and so where who they are is asked,
// whichever region a match is on.
/** @param {string[]} hosts */
export const homeOf = hosts => `${LOCAL.test(hosts[0]) ? "http" : "https"}://${hosts[0]}`;

/**
 * @param {string} link A match (`/w/<id>/`) or room (`/r/<id>/`) page on stv.tf, with or without `https://`.
 * @param {string[]} hosts The hosts voice may go to; `localhost` ones also over plain http.
 * @returns {{ voice: string; who: string; page: string } | null}
 */
export function matchOf(link, hosts) {
  let url;
  try {
    url = new URL(/^https?:\/\//.test(link) ? link : `https://${link}`);
  } catch {
    return null;
  }
  const local = LOCAL.test(url.host);
  if (!hosts.includes(url.host) || (url.protocol !== "https:" && !local)) return null;
  const m = url.pathname.match(/^\/([wr])\/([0-9a-z]{1,64})(\/|$)/);
  if (!m) return null;
  const page = `${url.origin}/${m[1]}/${m[2]}/`;
  return { voice: `${page}voice`, who: `${homeOf(hosts)}/voice/who`, page };
}
