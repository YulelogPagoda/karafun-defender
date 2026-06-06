'use strict';

// rewrite.js — pure upstream-response rewriting for the CLOUD case (World C).
//
// When the proxied room is KaraFun's cloud SPA, its HTML/JS reference absolute
// `https://<upstream-host>` URLs and open a `wss://<upstream-host>` socket — all
// of which would go straight to the cloud, bypassing us. To stay transparent AND
// keep every request flowing through the proxy, we rewrite those references to
// point back at our origin: the browser then talks only to us, and we forward.
//
// This is deliberately literal string replacement of the upstream host in its
// various URL forms. It is best-effort and brittle by nature (a frontend deploy
// can change things) — that's the documented trade-off of the cloud framing.
//
// Scope (v1): a single upstream host. Multiple backend hosts (separate api/cdn
// subdomains) would need path-routed upstreams — not built.

/**
 * Rewrite upstream-host URLs in a text body to our host.
 *
 * @param {string} text
 * @param {object} opts
 * @param {string} opts.upstreamHost  e.g. "www.karafun.com" (may include :port)
 * @param {string} opts.ourHost       our host as the guest sees it, e.g. "192.168.1.42:8080"
 * @returns {string}
 */
function rewriteBody(text, opts) {
  const { upstreamHost, ourHost } = opts || {};
  if (!text || !upstreamHost || !ourHost) return text;

  const ourOrigin = `http://${ourHost}`;
  const ourWs = `ws://${ourHost}`;
  let out = text;

  // Order matters: ws/wss first (so the http/https pass doesn't eat the host),
  // then absolute http(s), then protocol-relative.
  out = out.split(`wss://${upstreamHost}`).join(ourWs);
  out = out.split(`ws://${upstreamHost}`).join(ourWs);
  out = out.split(`https://${upstreamHost}`).join(ourOrigin);
  out = out.split(`http://${upstreamHost}`).join(ourOrigin);
  out = out.split(`//${upstreamHost}`).join(`//${ourHost}`); // protocol-relative

  return out;
}

/** Content types we treat as text and will rewrite. */
function isTextual(contentType) {
  return /text\/html|javascript|application\/json|text\/css|application\/xml|text\/plain/i
    .test(contentType || '');
}

module.exports = { rewriteBody, isTextual };
