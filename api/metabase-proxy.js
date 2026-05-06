// api/metabase-proxy.js — Edge Function. Proxies /api/metabase/:path* to
// ${METABASE_URL}/:path*. Pass-through for headers, body, and streaming.
//
// This sidesteps CORS and lets us put `METABASE_URL` in a server env var
// instead of hardcoding it in the client.

export const config = { runtime: 'edge' };

const PASSTHROUGH_REQ_HEADERS = new Set([
  'content-type',
  'accept',
  'x-metabase-session',
  'x-api-key',
  'authorization',
]);

const STRIP_RES_HEADERS = new Set([
  'transfer-encoding',
  'connection',
  'content-encoding', // body is already decoded by fetch when streaming through
]);

export default async function handler(req) {
  const base = (typeof process !== 'undefined' && process.env && process.env.METABASE_URL) || '';
  if (!base) {
    return new Response(JSON.stringify({ error: 'METABASE_URL not set' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  const url = new URL(req.url);
  // Vercel rewrite passes the captured path as ?p=...
  const subPath = url.searchParams.get('p') || '';
  const target = new URL(base.replace(/\/+$/, '') + '/' + subPath.replace(/^\/+/, ''));
  // Forward all query params except `p`
  for (const [k, v] of url.searchParams) {
    if (k === 'p') continue;
    target.searchParams.append(k, v);
  }

  const headers = new Headers();
  for (const [k, v] of req.headers) {
    if (PASSTHROUGH_REQ_HEADERS.has(k.toLowerCase())) headers.set(k, v);
  }

  const init = {
    method: req.method,
    headers,
    redirect: 'manual',
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req.body;
    // @ts-ignore — required when body is a stream in undici
    init.duplex = 'half';
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), init);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Upstream fetch failed', detail: String(e) }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }

  const resHeaders = new Headers();
  for (const [k, v] of upstream.headers) {
    if (STRIP_RES_HEADERS.has(k.toLowerCase())) continue;
    resHeaders.set(k, v);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: resHeaders,
  });
}
