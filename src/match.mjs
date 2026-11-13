// Where a match's voice goes, from a link someone gave: only on the hosts given (`STVTF_HOSTS`),
// so the key never goes anywhere else.

const LOCAL = /^(localhost|127\.0\.0\.1)(:\d+)?$/;

/** A host's origin: a local one over plain http. @param {string} host */
export const originOf = host => `${LOCAL.test(host) ? "http" : "https"}://${host}`;

// The first host: where people link their Steam account, and so where who they are is asked,
// whichever region a match is on.
/** @param {string[]} hosts */
export const homeOf = hosts => originOf(hosts[0]);

/**
 * A link as a URL, if it is on one of `hosts` and over https (or a local one's http).
 * @param {string} link @param {string[]} hosts @returns {URL | null}
 */
function urlOn(link, hosts) {
  const schemed = /^https?:\/\//.test(link);
  let url;
  try {
    url = new URL(schemed ? link : `https://${link}`);
  } catch {
    return null;
  }
  const local = LOCAL.test(url.host);
  // Given without a scheme: a local stv.tf has no https.
  if (local && !schemed) url.protocol = "http:";
  return hosts.includes(url.host) && (url.protocol === "https:" || local) ? url : null;
}

/**
 * @param {string} link A match (`/w/<id>/`) or room (`/r/<id>/`) page on stv.tf, with or without `https://`.
 * @param {string[]} hosts The hosts voice may go to; `localhost` ones also over plain http.
 * @returns {{ voice: string; whoUrl: string; page: string; invite: string | null } | null}
 */
export function matchOf(link, hosts) {
  const url = urlOn(link, hosts);
  if (!url) return null;
  const m = url.pathname.match(/^\/([wr])\/([0-9a-z]{1,64})(\/|$)/);
  if (!m) return null;
  const page = `${url.origin}/${m[1]}/${m[2]}/`;
  // The invite stv.tf gave whoever started the match, or a caster: no voice comes in without it.
  const invite = url.searchParams.get("voice");
  return {
    voice: `${page}voice`,
    whoUrl: `${homeOf(hosts)}/voice/who`,
    page,
    invite: invite && /^[0-9a-f]{8,64}$/.test(invite) ? invite : null,
  };
}
