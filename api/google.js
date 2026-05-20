// api/google.js — shared helper for the Google OAuth + Sheets endpoints.
//
// Runs as a Vercel Edge Function (`runtime: 'edge'`) and as a regular
// Node 18+ handler under server.js. Both expose `globalThis.fetch`.

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_API  = 'https://www.googleapis.com/drive/v3/files';

// Scopes:
//   - spreadsheets: create, append, update, batchUpdate, values.get, values.clear
//   - drive.metadata.readonly: list the operator's existing sheets so they
//     can pick an old one to bind instead of creating fresh.
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
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

// Create a spreadsheet. Two call shapes:
//   1. Legacy single-tab:  { title, headerRow }            -> creates "Sheet1"
//   2. Multi-tab:          { title, worksheets: [...] }     -> one tab per spec
//
// worksheets entries: { name: 'Landers', headerRow: ['id', 'slug', ...] }
//
// Returns { sheetId, url, gid, tabs: [{ name, gid }] }. `gid` is the first
// tab's gid (kept for backwards compat with the existing single-tab caller).
export async function createSpreadsheet({ access_token, title, headerRow, worksheets }) {
  const tabs = Array.isArray(worksheets) && worksheets.length
    ? worksheets
    : [{ name: 'Sheet1', headerRow: Array.isArray(headerRow) ? headerRow : [] }];

  // Step 1: create the spreadsheet with all requested tabs.
  const createRes = await fetch(SHEETS_API, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${access_token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      properties: { title: title || 'SidelineSwap Merch Bulk Import' },
      sheets: tabs.map((t) => ({ properties: { title: t.name } })),
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

  // Map each requested tab to the gid Google assigned (order is preserved by
  // the API, but we look up by title to be safe).
  const titleToGid = new Map();
  for (const s of created.sheets || []) {
    const p = s.properties;
    if (p && typeof p.sheetId === 'number') titleToGid.set(p.title, p.sheetId);
  }
  const tabsOut = tabs.map((t) => ({
    name: t.name,
    gid: titleToGid.has(t.name) ? titleToGid.get(t.name) : 0,
  }));
  const firstGid = tabsOut[0] ? tabsOut[0].gid : 0;

  // Step 2: write each tab's header row.
  for (const t of tabs) {
    if (Array.isArray(t.headerRow) && t.headerRow.length) {
      await appendValues({ access_token, sheetId, rows: [t.headerRow], tab: t.name });
    }
  }

  return { sheetId, url, gid: firstGid, tabs: tabsOut };
}

export async function appendValues({ access_token, sheetId, rows, tab }) {
  const a1 = `${tab || 'Sheet1'}!A1`;
  const range = encodeURIComponent(a1);
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

// Apply cell formatting via spreadsheets.batchUpdate. Pass an array of
// repeatCell-shaped requests built by the caller (the dashboard composes them
// from changed column indices + the row range it stashed on the entry).
export async function batchUpdate({ access_token, sheetId, requests }) {
  const url = `${SHEETS_API}/${encodeURIComponent(sheetId)}:batchUpdate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${access_token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Sheets batchUpdate ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Read a range of cell values via spreadsheets.values.get. Used to pull the
// model_id column out of the bound Sheet so we can flag models another
// operator has already queued.
export async function readValues({ access_token, sheetId, range }) {
  const url = `${SHEETS_API}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'authorization': `Bearer ${access_token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Sheets read ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Fetch lightweight spreadsheet metadata so the browser can recover the
// worksheet `gid` for bindings created before we started capturing it (or
// when the operator points the dashboard at a hand-made sheet). Returns
// `{ gid, title, tabs: [{ name, gid }] }`. `gid` + `title` are the first
// tab's values (kept for backwards compat with the existing single-tab
// callers); `tabs` is the full list, used by the multi-tab bulk-import flow
// to validate that all four required tabs exist on a linked sheet.
export async function getSpreadsheetMeta({ access_token, sheetId, properties }) {
  // fields= keeps the response small. Include the spreadsheet title when the
  // caller asks for it -- needed when binding to an existing sheet so the UI
  // can display its name.
  const fieldList = ['sheets.properties.sheetId', 'sheets.properties.title'];
  if (properties) fieldList.push('properties.title');
  const url = `${SHEETS_API}/${encodeURIComponent(sheetId)}?fields=${encodeURIComponent(fieldList.join(','))}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'authorization': `Bearer ${access_token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Sheets meta ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const tabs = (data.sheets || [])
    .map((s) => s && s.properties)
    .filter((p) => p && typeof p.sheetId === 'number')
    .map((p) => ({ name: p.title || '', gid: p.sheetId }));
  if (!tabs.length) {
    throw new Error('Sheets meta: no sheets in response');
  }
  const ssTitle = data.properties && data.properties.title || null;
  return {
    gid: tabs[0].gid,
    title: tabs[0].name || 'Sheet1',
    tabs,
    spreadsheetTitle: ssTitle,
  };
}

// List the operator's Google Sheets via the Drive API. Used by the "browse
// existing sheets" picker. Requires the drive.metadata.readonly scope.
// Returns an array of { id, name, modifiedTime, webViewLink }.
export async function listDriveSheets({ access_token, pageSize }) {
  const params = new URLSearchParams({
    q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    fields: 'files(id,name,modifiedTime,webViewLink)',
    orderBy: 'modifiedTime desc',
    pageSize: String(Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100)),
  });
  const res = await fetch(`${DRIVE_API}?${params.toString()}`, {
    method: 'GET',
    headers: { 'authorization': `Bearer ${access_token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Drive list ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return Array.isArray(data.files) ? data.files : [];
}

// Wipe the data rows of one or more A1 ranges, preserving the headers. Used
// by the "Clear sheet contents" button in Settings. `ranges` example:
//   ['Landers!A2:Z', 'Blocks!A2:Z', 'Page View Block Relations!A2:Z',
//    'Block Tile Relations!A2:Z']
export async function batchClearValues({ access_token, sheetId, ranges }) {
  const url = `${SHEETS_API}/${encodeURIComponent(sheetId)}/values:batchClear`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${access_token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ranges }),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Sheets clear ${res.status}: ${text.slice(0, 400)}`);
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
