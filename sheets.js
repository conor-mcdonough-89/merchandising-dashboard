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
//   localStorage['merch-google-tokens']  -> { access_token, refresh_token, expires_at }
//   localStorage['merch-sheets-binding'] -> { sheetId, url, title, createdAt }

(function (global) {
  const TOKENS_KEY = 'merch-google-tokens';
  const BINDING_KEY = 'merch-sheets-binding';
  const STATE_KEY = 'merch-google-oauth-state';
  const VERIFIER_KEY = 'merch-google-pkce-verifier';

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

  global.Sheets = {
    startAuth,
    disconnect,
    isConnected,
    loadBinding,
    createSheet,
    appendRows,
  };
})(window);
