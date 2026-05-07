// api/google.js — shared helper for the Google OAuth + Sheets endpoints.
//
// Runs as a Vercel Edge Function (`runtime: 'edge'`) and as a regular
// Node 18+ handler under server.js. Both expose `globalThis.fetch`.

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

// Scope: spreadsheets is enough for create + append. Drive metadata not needed.
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
];

export function getEnv() {
  const env = (typeof process !== 'undefined' && process.env) || {};
  return {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID || null,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET || null,
    redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI || null,
  };
}

export function requireOAuthEnv() {
  const env = getEnv();
  const missing = Object.entries(env)
    .filter(([_, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    const err = new Error(`Google OAuth env not set: ${missing.join(', ')}`);
    err.code = 'NO_GOOGLE_ENV';
    throw err;
  }
  return env;
}

// Exchange an auth code for tokens. Uses PKCE — code_verifier is required;
// client_secret is also required because we registered as a Web app
// (Google still requires it even with PKCE).
export async function exchangeCode({ code, code_verifier }) {
  const { clientId, clientSecret, redirectUri } = requireOAuthEnv();
  const body = new URLSearchParams({
    code,
    code_verifier,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Token exchange ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function refreshToken({ refresh_token }) {
  const { clientId, clientSecret } = requireOAuthEnv();
  const body = new URLSearchParams({
    refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Token refresh ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  // Note: refresh response does NOT include a new refresh_token.
  return res.json();
}

export async function createSpreadsheet({ access_token, title, headerRow }) {
  // Step 1: create the spreadsheet.
  const createRes = await fetch(SHEETS_API, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${access_token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      properties: { title: title || 'SidelineSwap Merch Bulk Import' },
      sheets: [{ properties: { title: 'Sheet1' } }],
    }),
  });
  if (!createRes.ok) {
    const text = await createRes.text();
    const err = new Error(`Sheets create ${createRes.status}: ${text.slice(0, 400)}`);
    err.status = createRes.status;
    throw err;
  }
  const created = await createRes.json();
  const sheetId = created.spreadsheetId;
  const url = created.spreadsheetUrl;

  // Step 2: write the header row.
  if (Array.isArray(headerRow) && headerRow.length) {
    await appendValues({ access_token, sheetId, rows: [headerRow] });
  }

  return { sheetId, url };
}

export async function appendValues({ access_token, sheetId, rows }) {
  const range = encodeURIComponent('Sheet1!A1');
  const url = `${SHEETS_API}/${encodeURIComponent(sheetId)}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${access_token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ values: rows }),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Sheets append ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  // Returns { spreadsheetId, tableRange?, updates: { updatedRange, updatedRows, ... } }
  // updates.updatedRange is the per-call range we stash on the IndexedDB entry
  // so subsequent edits target the same row via updateValues below.
  return res.json();
}

// Overwrite a previously-appended row in place. `range` is the A1 range that
// `appendValues` returned (e.g. "Sheet1!A4:S4"); `row` is the full 19-column
// values array. valueInputOption=RAW so we don't re-interpret cell contents.
export async function updateValues({ access_token, sheetId, range, row }) {
  const url = `${SHEETS_API}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'authorization': `Bearer ${access_token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Sheets update ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
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

export function html(body, init = {}) {
  return new Response(body, {
    ...init,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...(init.headers || {}),
    },
  });
}
