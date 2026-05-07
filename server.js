// server.js — zero-dep Node fallback for self-hosting.
// Serves the static SPA and mirrors the Vercel Edge Functions:
//   /api/metabase/:path*           -> ${METABASE_URL}/:path*
//   /api/propose/merges            -> api/propose/merges.js handler
//   /api/propose/renames           -> api/propose/renames.js handler
//   /api/propose/conventions       -> api/propose/conventions.js handler
//   /api/google/config             -> api/google/config.js handler
//   /api/google/auth-exchange      -> api/google/auth-exchange.js handler
//   /api/google/auth-refresh       -> api/google/auth-refresh.js handler
//   /api/google/auth-callback      -> api/google/auth-callback.js handler
//   /api/google/sheets-create      -> api/google/sheets-create.js handler
//   /api/google/sheets-append      -> api/google/sheets-append.js handler
//   /api/conventions/list          -> api/conventions/list.js handler
//   /api/conventions/upsert        -> api/conventions/upsert.js handler
//
// Requires Node ≥18 (uses globalThis.fetch).
//
//   METABASE_URL=https://metabase.example.com \
//   ANTHROPIC_API_KEY=sk-ant-... \
//   GOOGLE_OAUTH_CLIENT_ID=... \
//   GOOGLE_OAUTH_CLIENT_SECRET=... \
//   GOOGLE_OAUTH_REDIRECT_URI=http://localhost:8080/api/google/auth-callback \
//   PORT=8080 npm start

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const PORT = Number(process.env.PORT || 8080);
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
};

// Serve a static file. Returns true if it served, false if not found.
function serveStatic(req, res) {
  const parsed = url.parse(req.url);
  let pathname = decodeURIComponent(parsed.pathname || '/');
  if (pathname === '/') pathname = '/index.html';
  // Block path traversal
  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return true;
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return false;
  }
  if (stat.isDirectory()) return false;
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader('content-type', MIME[ext] || 'application/octet-stream');
  res.setHeader('cache-control', 'no-cache');
  fs.createReadStream(filePath).pipe(res);
  return true;
}

// -------- Metabase proxy --------

async function metabaseProxy(req, res) {
  const base = process.env.METABASE_URL;
  if (!base) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'METABASE_URL not set' }));
    return;
  }
  const parsed = url.parse(req.url, true);
  const subPath = parsed.pathname.replace(/^\/api\/metabase\/?/, '');
  const target = new URL(base.replace(/\/+$/, '') + '/' + subPath);
  for (const [k, v] of Object.entries(parsed.query || {})) {
    if (Array.isArray(v)) v.forEach((vv) => target.searchParams.append(k, vv));
    else if (v != null) target.searchParams.append(k, v);
  }

  const passthrough = ['content-type', 'accept', 'x-metabase-session', 'x-api-key', 'authorization'];
  const headers = {};
  for (const k of passthrough) {
    const v = req.headers[k];
    if (v != null) headers[k] = v;
  }

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await readRawBody(req);
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: req.method,
      headers,
      body,
    });
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Upstream fetch failed', detail: String(e) }));
    return;
  }
  res.statusCode = upstream.status;
  upstream.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (lk === 'transfer-encoding' || lk === 'connection' || lk === 'content-encoding') return;
    res.setHeader(key, value);
  });
  if (upstream.body) {
    const reader = upstream.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    };
    await pump();
  } else {
    res.end();
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Wrap a Node IncomingMessage as a Web Request-ish for the Edge handlers.
function nodeReqToFetchReq(req, body) {
  const fullUrl = `http://localhost:${PORT}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((vv) => headers.append(k, vv));
    else if (v != null) headers.set(k, v);
  }
  const init = { method: req.method, headers };
  if (body && req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = body;
  }
  return new Request(fullUrl, init);
}

async function dispatchEdge(handler, req, res) {
  let body = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await readRawBody(req);
  }
  const fetchReq = nodeReqToFetchReq(req, body);
  const out = await handler(fetchReq);
  res.statusCode = out.status;
  out.headers.forEach((v, k) => res.setHeader(k, v));
  const buf = Buffer.from(await out.arrayBuffer());
  res.end(buf);
}

// -------- routing --------

const ROUTES = [
  { match: (u) => u.startsWith('/api/metabase/') || u === '/api/metabase', handle: metabaseProxy },
];

const EDGE_ROUTES = [
  { path: '/api/propose/merges',          module: './api/propose/merges.js' },
  { path: '/api/propose/renames',         module: './api/propose/renames.js' },
  { path: '/api/propose/conventions',     module: './api/propose/conventions.js' },
  { path: '/api/google/config',           module: './api/google/config.js' },
  { path: '/api/google/auth-exchange',    module: './api/google/auth-exchange.js' },
  { path: '/api/google/auth-refresh',     module: './api/google/auth-refresh.js' },
  { path: '/api/google/auth-callback',    module: './api/google/auth-callback.js' },
  { path: '/api/google/sheets-create',    module: './api/google/sheets-create.js' },
  { path: '/api/google/sheets-append',    module: './api/google/sheets-append.js' },
  { path: '/api/conventions/list',        module: './api/conventions/list.js' },
  { path: '/api/conventions/upsert',      module: './api/conventions/upsert.js' },
];

const _edgeCache = new Map();
async function loadEdge(modulePath) {
  if (_edgeCache.has(modulePath)) return _edgeCache.get(modulePath);
  const mod = await import(modulePath);
  _edgeCache.set(modulePath, mod);
  return mod;
}

const server = http.createServer(async (req, res) => {
  const u = (req.url || '/').split('?')[0];

  try {
    for (const r of ROUTES) {
      if (r.match(u)) return await r.handle(req, res);
    }
    for (const r of EDGE_ROUTES) {
      if (u === r.path) {
        const mod = await loadEdge(r.module);
        return await dispatchEdge(mod.default, req, res);
      }
    }
    if (serveStatic(req, res)) return;
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Not found');
  } catch (e) {
    console.error('[server] error handling', req.url, e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
    }
    res.end(JSON.stringify({ error: String(e && e.message || e) }));
  }
});

server.listen(PORT, () => {
  console.log(`merch-dashboard listening on http://localhost:${PORT}`);
  if (!process.env.METABASE_URL) console.log('  (METABASE_URL not set — Metabase proxy will return 500)');
  if (!process.env.ANTHROPIC_API_KEY) console.log('  (ANTHROPIC_API_KEY not set — propose endpoints will return 500)');
  if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET || !process.env.GOOGLE_OAUTH_REDIRECT_URI) {
    console.log('  (GOOGLE_OAUTH_* not set — Google Sheets connector will return 500)');
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('  (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — conventions endpoints will return 500)');
  }
});
