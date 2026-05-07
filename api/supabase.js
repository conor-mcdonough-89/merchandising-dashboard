// api/supabase.js — shared helper for the conventions endpoints.
// Holds env-var validators and a thin PostgREST fetch wrapper.
// Service-role key is server-side only and never returned to the browser.
//
// Runs as a Vercel Edge Function (`runtime: 'edge'`) and as a regular
// Node 18+ handler under server.js. Both expose `globalThis.fetch`.

export function getEnv() {
  const env = (typeof process !== 'undefined' && process.env) || {};
  return {
    url: env.SUPABASE_URL || null,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || null,
  };
}

export function requireEnv() {
  const env = getEnv();
  const missing = [];
  if (!env.url) missing.push('SUPABASE_URL');
  if (!env.serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    const err = new Error(`Supabase env not set: ${missing.join(', ')}`);
    err.code = 'NO_SUPABASE_ENV';
    throw err;
  }
  return env;
}

// supabaseFetch('/rest/v1/conventions?...', { method: 'POST', body, prefer: 'return=representation' })
export async function supabaseFetch(path, init = {}) {
  const { url, serviceRoleKey } = requireEnv();
  const target = `${url.replace(/\/+$/, '')}${path.startsWith('/') ? path : '/' + path}`;
  const headers = new Headers(init.headers || {});
  headers.set('apikey', serviceRoleKey);
  headers.set('Authorization', `Bearer ${serviceRoleKey}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (init.prefer) headers.set('Prefer', init.prefer);

  const res = await fetch(target, {
    method: init.method || 'GET',
    headers,
    body: init.body || undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Supabase ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.upstream = text;
    throw err;
  }
  // Some PostgREST responses are empty (204) — be resilient.
  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('application/json')) return null;
  return res.json();
}

// -------- shared response helpers (mirror of api/anthropic.js) --------

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

export async function readJsonBody(req) {
  if (typeof req.json === 'function') return req.json();
  const text = await new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
  return JSON.parse(text || '{}');
}
