// sheets.js — Google Sheets client for the merch dashboard.
// All Google API calls go through /api/google/* (Edge proxies that hold
// GOOGLE_OAUTH_CLIENT_SECRET server-side).
//
// OAuth flow: PKCE authorization-code in a popup.
//   1. Sheets.startAuth() builds a code_verifier + code_challenge.
//   2. window.open(...google authorize url...).
//   3. Google redirects to /api/google/auth-callback, which postMessages
//      { code, state } back to this window.
//   4. We POST { code, code_verifier } to /api/google/auth-exchange.
//   5. Tokens go to localStorage; refresh_token used to silently refresh
//      the access_token before each Sheets call.
//
// Storage:
//   localStorage['merch-google-tokens']           -> { access_token, refresh_token, expires_at }
//   localStorage['merch-sheets-binding']          -> { sheetId, url, gid, title, createdAt }
//     The models-tool single-tab sheet (untouched).
//   localStorage['merch-landers-sheets-binding']  -> { sheetId, url, title, createdAt,
//                                                      tabs: [{ name, gid }] }
//     The multi-tab bulk-import sheet (Landers + Blocks + PVBR + BTR). Held
//     under a separate key so the two flows never collide.

(function (global) {
  const TOKENS_KEY = 'merch-google-tokens';
  const BINDING_KEY = 'merch-sheets-binding';
  const LANDERS_BINDING_KEY = 'merch-landers-sheets-binding';
  const STATE_KEY = 'merch-google-oauth-state';
  const VERIFIER_KEY = 'merch-google-pkce-verifier';

  // Required tab names for the multi-tab bulk-import sheet. Read from
  // Templates.BULK_IMPORT_TABS if it's loaded; fall back to the hardcoded
  // list so this module doesn't blow up if loaded out of order.
  function requiredBulkTabs() {
    const t = global.Templates && global.Templates.BULK_IMPORT_TABS;
    if (Array.isArray(t) && t.length) return t;
    return [
      { name: 'Landers', headerRow: [] },
      { name: 'Blocks', headerRow: [] },
      { name: 'Page View Block Relations', headerRow: [] },
      { name: 'Block Tile Relations', headerRow: [] },
    ];
  }

  const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

  // -------- token storage --------

  function loadTokens() {
    try {
      const raw = localStorage.getItem(TOKENS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }
  function saveTokens(t) {
    if (!t) localStorage.removeItem(TOKENS_KEY);
    else localStorage.setItem(TOKENS_KEY, JSON.stringify(t));
  }
  function loadBinding() {
    try {
      const raw = localStorage.getItem(BINDING_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }
  function saveBinding(b) {
    if (!b) localStorage.removeItem(BINDING_KEY);
    else localStorage.setItem(BINDING_KEY, JSON.stringify(b));
  }

  function loadLandersBinding() {
    try {
      const raw = localStorage.getItem(LANDERS_BINDING_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }
  function saveLandersBinding(b) {
    if (!b) localStorage.removeItem(LANDERS_BINDING_KEY);
    else localStorage.setItem(LANDERS_BINDING_KEY, JSON.stringify(b));
  }
  function disconnectLandersBinding() {
    saveLandersBinding(null);
  }

  // -------- PKCE helpers --------

  function randomString(len) {
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function sha256Base64Url(input) {
    const bytes = new TextEncoder().encode(input);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    let binary = '';
    const bv = new Uint8Array(hash);
    for (let i = 0; i < bv.length; i++) binary += String.fromCharCode(bv[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // -------- OAuth flow --------

  async function fetchOAuthConfig() {
    const res = await fetch('/api/google/config');
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google config ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  // Opens a popup, drives the OAuth flow, and resolves with tokens.
  async function startAuth() {
    const cfg = await fetchOAuthConfig();
    const state = randomString(16);
    const verifier = randomString(48);
    const challenge = await sha256Base64Url(verifier);
    sessionStorage.setItem(STATE_KEY, state);
    sessionStorage.setItem(VERIFIER_KEY, verifier);

    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: 'code',
      scope: (cfg.scopes || []).join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    });

    const url = `${GOOGLE_AUTH_URL}?${params.toString()}`;
    const popup = window.open(url, 'merch-google-oauth', 'width=520,height=640');
    if (!popup) throw new Error('Popup blocked. Allow popups for this site and try again.');

    const code = await new Promise((resolve, reject) => {
      const onMessage = (ev) => {
        if (!ev.data || ev.data.type !== 'merch-google-oauth') return;
        if (ev.data.error) {
          cleanup();
          reject(new Error(`Google sign-in: ${ev.data.error}`));
          return;
        }
        if (ev.data.state !== state) {
          cleanup();
          reject(new Error('OAuth state mismatch'));
          return;
        }
        cleanup();
        resolve(ev.data.code);
      };
      const onTick = () => {
        if (popup.closed) {
          cleanup();
          reject(new Error('Sign-in window was closed before completing.'));
        }
      };
      const tick = setInterval(onTick, 600);
      const cleanup = () => {
        window.removeEventListener('message', onMessage);
        clearInterval(tick);
      };
      window.addEventListener('message', onMessage);
    });

    const exchangeRes = await fetch('/api/google/auth-exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier }),
    });
    if (!exchangeRes.ok) {
      const text = await exchangeRes.text();
      throw new Error(`Token exchange ${exchangeRes.status}: ${text.slice(0, 200)}`);
    }
    const tokens = await exchangeRes.json();
    sessionStorage.removeItem(STATE_KEY);
    sessionStorage.removeItem(VERIFIER_KEY);
    persistTokens(tokens);
    return tokens;
  }

  function persistTokens(tokens) {
    const expiresAt = Date.now() + Math.max(0, (tokens.expires_in || 3600) - 60) * 1000;
    const existing = loadTokens() || {};
    saveTokens({
      access_token: tokens.access_token,
      // Google omits refresh_token on refresh responses; keep the existing one.
      refresh_token: tokens.refresh_token || existing.refresh_token || null,
      expires_at: expiresAt,
    });
  }

  async function refreshIfNeeded() {
    const t = loadTokens();
    if (!t) return null;
    if (t.expires_at && t.expires_at > Date.now() + 5_000) return t.access_token;
    if (!t.refresh_token) return null;
    const res = await fetch('/api/google/auth-refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: t.refresh_token }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token refresh ${res.status}: ${text.slice(0, 200)}`);
    }
    const fresh = await res.json();
    persistTokens(fresh);
    return loadTokens().access_token;
  }

  function isConnected() {
    const t = loadTokens();
    return !!(t && (t.access_token || t.refresh_token));
  }

  function disconnect() {
    saveTokens(null);
    saveBinding(null);
  }

  // -------- Sheets API (proxied) --------

  async function createSheet({ title, headerRow }) {
    const access_token = await refreshIfNeeded();
    if (!access_token) throw new Error('Not connected to Google. Connect first.');
    const res = await fetch('/api/google/sheets-create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token, title, headerRow }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Sheets create ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    saveBinding({
      sheetId: data.sheetId,
      url: data.url,
      gid: typeof data.gid === 'number' ? data.gid : 0,
      title: title || 'SidelineSwap Merch Bulk Import',
      createdAt: new Date().toISOString(),
    });
    return data;
  }

  async function appendRows(rows) {
    const binding = loadBinding();
    if (!binding) throw new Error('No sheet bound. Click Create Sheet first.');
    if (!Array.isArray(rows) || !rows.length) return { appended: 0 };
    const access_token = await refreshIfNeeded();
    if (!access_token) throw new Error('Not connected to Google. Connect first.');
    const res = await fetch('/api/google/sheets-append', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token, sheetId: binding.sheetId, rows }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Sheets append ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  // Overwrite a previously-appended row in place. `range` is the value our
  // append call returned via updates.updatedRange (e.g. "Sheet1!A4:S4");
  // `row` is the full 19-column values array.
  async function updateRow(range, row) {
    const binding = loadBinding();
    if (!binding) throw new Error('No sheet bound. Click Create Sheet first.');
    if (!range) throw new Error('updateRow requires a range');
    const access_token = await refreshIfNeeded();
    if (!access_token) throw new Error('Not connected to Google. Connect first.');
    const res = await fetch('/api/google/sheets-update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token, sheetId: binding.sheetId, range, row }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Sheets update ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  // Resolve the worksheet's numeric gid (sheetId in the Sheets API). For
  // bindings created before we captured gid on createSheet, recover it via
  // /api/google/sheets-meta and persist it. Cell formatting requires this
  // exact gid -- defaulting to 0 fails with "No grid with id: 0" when the
  // worksheet's actual id isn't 0.
  async function ensureGid() {
    const binding = loadBinding();
    if (!binding) throw new Error('No sheet bound.');
    if (typeof binding.gid === 'number') return binding.gid;
    const access_token = await refreshIfNeeded();
    if (!access_token) throw new Error('Not connected to Google.');
    const res = await fetch('/api/google/sheets-meta', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token, sheetId: binding.sheetId }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Sheets meta ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    saveBinding({ ...binding, gid: data.gid });
    return data.gid;
  }

  // Apply yellow background to a set of cells. `range` is the A1 range we
  // stashed on the entry (e.g. "Sheet1!A4:S4"); `columnIndices` are zero-based.
  // Builds spreadsheets.batchUpdate repeatCell requests and POSTs them to the
  // sheets-format Edge Function.
  async function highlightCells({ range, columnIndices }) {
    const binding = loadBinding();
    if (!binding) throw new Error('No sheet bound.');
    if (!range || !Array.isArray(columnIndices) || !columnIndices.length) return { skipped: true };
    const access_token = await refreshIfNeeded();
    if (!access_token) throw new Error('Not connected to Google.');
    const rowIndex = parseRowIndexFromRange(range);
    if (rowIndex < 0) throw new Error(`Couldn't parse row from range: ${range}`);
    const gid = await ensureGid();
    const requests = columnIndices.map((col) => ({
      repeatCell: {
        range: {
          sheetId: gid,
          startRowIndex: rowIndex,
          endRowIndex: rowIndex + 1,
          startColumnIndex: col,
          endColumnIndex: col + 1,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 1.0, green: 0.95, blue: 0.5, alpha: 1 },
          },
        },
        fields: 'userEnteredFormat.backgroundColor',
      },
    }));
    const res = await fetch('/api/google/sheets-format', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token, sheetId: binding.sheetId, requests }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Sheets format ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  // Parse the zero-based row index from an A1 range like "Sheet1!A4:S4". Picks
  // the digits after the first column letter; returns -1 on failure.
  function parseRowIndexFromRange(range) {
    const m = /[A-Z]+(\d+)/.exec(range || '');
    if (!m) return -1;
    return parseInt(m[1], 10) - 1;
  }

  // Read columns A (model_id) through I (name) from the bound Sheet, skipping
  // the header row. Returns a Map<sourceId, { newName?, newState?,
  // mergeTargetId? }> so cross-operator pending changes can show the same
  // inline diff as local actions. The sheets-read endpoint is unchanged --
  // we just hand it a wider range.
  // Column layout (from BULK_IMPORT_HEADERS): 0=model_id, 5=state,
  //   6=merge_target_id, 8=name.
  async function readPendingActions() {
    const binding = loadBinding();
    if (!binding) throw new Error('No sheet bound.');
    const access_token = await refreshIfNeeded();
    if (!access_token) throw new Error('Not connected to Google.');
    const res = await fetch('/api/google/sheets-read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token, sheetId: binding.sheetId, range: 'Sheet1!A2:I' }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Sheets read ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const map = new Map();
    for (const row of data.values || []) {
      if (!row || !row.length) continue;
      const sourceId = parseInt(row[0], 10);
      if (Number.isNaN(sourceId)) continue;
      const state = (row[5] || '').toString().trim();
      const mergeTargetIdRaw = row[6];
      const newName = (row[8] || '').toString().trim();
      const mergeTargetId = mergeTargetIdRaw === '' || mergeTargetIdRaw == null
        ? NaN : parseInt(mergeTargetIdRaw, 10);
      const action = {};
      if (state) action.newState = state;
      if (!Number.isNaN(mergeTargetId)) action.mergeTargetId = mergeTargetId;
      if (newName) action.newName = newName;
      if (Object.keys(action).length) map.set(sourceId, action);
    }
    return map;
  }

  // -------- Multi-tab bulk-import sheet (Landers + Blocks + PVBR + BTR) --------
  //
  // These methods operate on a SEPARATE binding from the models-tool sheet so
  // the two flows never collide. All take/return the landers binding shape:
  //   { sheetId, url, title, createdAt, tabs: [{ name, gid }] }

  // Create the four-tab sheet from Templates.BULK_IMPORT_TABS. Persists the
  // binding to localStorage and returns it.
  async function createBulkImportSheet(title) {
    const access_token = await refreshIfNeeded();
    if (!access_token) throw new Error('Not connected to Google. Connect first.');
    const tabs = requiredBulkTabs();
    const res = await fetch('/api/google/sheets-create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        access_token,
        title,
        worksheets: tabs.map((t) => ({ name: t.name, headerRow: t.headerRow })),
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Sheets create ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const binding = {
      sheetId: data.sheetId,
      url: data.url,
      title: title || 'SidelineSwap Merch Bulk Import',
      createdAt: new Date().toISOString(),
      tabs: Array.isArray(data.tabs) ? data.tabs : [],
    };
    saveLandersBinding(binding);
    return binding;
  }

  // Validate that `sheetId` is a real spreadsheet the operator has access to
  // AND that it has the four required tabs. On success, persists the binding
  // and returns it. Throws with a useful message otherwise.
  async function linkExistingSheet(sheetId) {
    if (!sheetId || typeof sheetId !== 'string') throw new Error('Sheet id required.');
    const access_token = await refreshIfNeeded();
    if (!access_token) throw new Error('Not connected to Google. Connect first.');
    const res = await fetch('/api/google/sheets-meta', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token, sheetId, properties: true }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Sheets meta ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const tabs = Array.isArray(data.tabs) ? data.tabs : [];
    const required = requiredBulkTabs().map((t) => t.name);
    const missing = required.filter((name) => !tabs.find((t) => t.name === name));
    if (missing.length) {
      throw new Error(`Linked sheet is missing required tab(s): ${missing.join(', ')}. Create a new sheet instead, or add these tabs manually.`);
    }
    const binding = {
      sheetId,
      url: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/edit`,
      title: data.spreadsheetTitle || tabs[0].name || 'Linked sheet',
      createdAt: new Date().toISOString(),
      tabs: required.map((name) => {
        const t = tabs.find((x) => x.name === name);
        return { name, gid: t ? t.gid : 0 };
      }),
    };
    saveLandersBinding(binding);
    return binding;
  }

  async function listDriveSheetsCall() {
    const access_token = await refreshIfNeeded();
    if (!access_token) throw new Error('Not connected to Google. Connect first.');
    const res = await fetch('/api/google/drive-list-sheets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Drive list ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return Array.isArray(data.files) ? data.files : [];
  }

  // Append rows to a specific tab on the landers binding. Returns the same
  // payload the underlying endpoint returns (so callers can pull
  // updates.updatedRange for later in-place updates).
  async function appendRowsToTab(tabName, rows) {
    const binding = loadLandersBinding();
    if (!binding) throw new Error('No bulk-import sheet bound. Create or link one in Settings.');
    if (!Array.isArray(rows) || !rows.length) return { appended: 0 };
    const access_token = await refreshIfNeeded();
    if (!access_token) throw new Error('Not connected to Google. Connect first.');
    const res = await fetch('/api/google/sheets-append', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token, sheetId: binding.sheetId, rows, tab: tabName }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Sheets append ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  // Overwrite a previously-appended row (on any tab) in place. `range` is
  // the worksheet-qualified A1 returned by appendRowsToTab.
  async function updateRowOnLandersBinding(range, row) {
    const binding = loadLandersBinding();
    if (!binding) throw new Error('No bulk-import sheet bound.');
    if (!range) throw new Error('updateRowOnLandersBinding requires a range');
    const access_token = await refreshIfNeeded();
    if (!access_token) throw new Error('Not connected to Google.');
    const res = await fetch('/api/google/sheets-update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token, sheetId: binding.sheetId, range, row }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Sheets update ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  // Yellow-highlight changed cells on the landers binding. `range` is a
  // worksheet-qualified A1 (e.g. "Landers!A4:P4"); `tabName` resolves the
  // correct gid for spreadsheets.batchUpdate.
  async function highlightCellsOnLandersBinding({ tabName, range, columnIndices }) {
    const binding = loadLandersBinding();
    if (!binding) throw new Error('No bulk-import sheet bound.');
    if (!range || !Array.isArray(columnIndices) || !columnIndices.length) return { skipped: true };
    const tab = (binding.tabs || []).find((t) => t.name === tabName);
    if (!tab) throw new Error(`Tab not found in binding: ${tabName}`);
    const access_token = await refreshIfNeeded();
    if (!access_token) throw new Error('Not connected to Google.');
    const rowIndex = parseRowIndexFromRange(range);
    if (rowIndex < 0) throw new Error(`Couldn't parse row from range: ${range}`);
    const requests = columnIndices.map((col) => ({
      repeatCell: {
        range: {
          sheetId: tab.gid,
          startRowIndex: rowIndex,
          endRowIndex: rowIndex + 1,
          startColumnIndex: col,
          endColumnIndex: col + 1,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 1.0, green: 0.95, blue: 0.5, alpha: 1 },
          },
        },
        fields: 'userEnteredFormat.backgroundColor',
      },
    }));
    const res = await fetch('/api/google/sheets-format', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token, sheetId: binding.sheetId, requests }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Sheets format ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  // Wipe data rows on all four tabs while preserving headers (A1).
  async function clearBulkImportSheet() {
    const binding = loadLandersBinding();
    if (!binding) throw new Error('No bulk-import sheet bound.');
    const access_token = await refreshIfNeeded();
    if (!access_token) throw new Error('Not connected to Google.');
    const tabs = (binding.tabs && binding.tabs.length)
      ? binding.tabs.map((t) => t.name)
      : requiredBulkTabs().map((t) => t.name);
    const ranges = tabs.map((name) => `${name}!A2:Z`);
    const res = await fetch('/api/google/sheets-clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token, sheetId: binding.sheetId, ranges }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Sheets clear ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  global.Sheets = {
    startAuth,
    disconnect,
    isConnected,
    loadBinding,
    createSheet,
    appendRows,
    updateRow,
    highlightCells,
    readPendingActions,
    // Multi-tab bulk-import sheet (landers binding):
    loadLandersBinding,
    disconnectLandersBinding,
    createBulkImportSheet,
    linkExistingSheet,
    listDriveSheets: listDriveSheetsCall,
    appendRowsToTab,
    updateRowOnLandersBinding,
    highlightCellsOnLandersBinding,
    clearBulkImportSheet,
  };
})(window);
