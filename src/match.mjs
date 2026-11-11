// Where a match's voice goes, from a link someone gave: only on the stv.tf hosts we know, so the
// key never goes anywhere else.

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
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(url.host);
  if (!hosts.includes(url.host) || (url.protocol !== "https:" && !local)) return null;
  const m = url.pathname.match(/^\/([wr])\/([0-9a-z]{1,64})(\/|$)/);
  if (!m) return null;
  const page = `${url.origin}/${m[1]}/${m[2]}/`;
  return { voice: `${page}voice`, who: `${url.origin}/voice/who`, page };
}
