// metabase.js — Metabase client for the merch dashboard.
// All HTTP goes through /api/metabase/* (Edge proxy → ${METABASE_URL}/*).
//
// Auth strategy:
//   1. If API_KEY is configured, send `X-API-KEY` header (works for SSO-only
//      Metabase installs where browser session login is unavailable).
//   2. Otherwise post username/password to /api/session, cache the
//      `id` token in localStorage as `merch-metabase-session`, and send it as
//      `X-Metabase-Session` on every request.
//   3. On 401 from the token path, clear the cached session and prompt for re-login.
//
// Database id `7` (BigQuery-POC) and schema `rails` are referenced by the
// SQL templates below.

(function (global) {
  const PROXY_BASE = '/api/metabase';
  const CONFIG_KEY = 'merch-metabase-config';
  const SESSION_KEY = 'merch-metabase-session';
  const DB_ID = 7;

  // Sports = sport-level roots (sport=1) that have at least one descendant
  // category carrying models. Used to label/filter the relatable-category list.
  const SPORTS_SQL = `
SELECT id, name, path
FROM rails.categories
WHERE sport = 1
  AND id IN (
    SELECT DISTINCT CAST(SPLIT(path, '/')[OFFSET(0)] AS INT64)
    FROM rails.categories
    WHERE has_models = 1
  )
ORDER BY position
`.trim();

  // Relatable categories = leaf categories with has_models=1 (the ones models
  // are actually attached to: "Baseball > Bats", "Hockey > Sticks", ...).
  // sport_id is the first segment of the category path.
  const CATEGORIES_SQL = `
SELECT
  c.id,
  c.name,
  c.full_name,
  c.path,
  CAST(SPLIT(c.path, '/')[OFFSET(0)] AS INT64) AS sport_id
FROM rails.categories AS c
WHERE c.has_models = 1
ORDER BY c.full_name
`.trim();

  // Models for a single relatable category. The category id is interpolated
  // server-side via runNativeQuery -- it's a server-controlled integer
  // (originating from CATEGORIES_SQL) so injection is not a concern, and
  // inlining sidesteps Metabase's BigQuery template-tag parameter binding,
  // which has bitten us with "Query parameter not found" errors.
  const MODELS_SQL_TEMPLATE = `
SELECT
  m.id,
  m.name,
  m.slug,
  m.state,
  m.description,
  m.primary_image_url,
  m.secondary_image_url,
  m.position,
  m.available_count,
  m.sold_count,
  m.last_90_sold_count,
  m.rank_position,
  m.brand_id,
  m.category_id,
  m.synonyms,
  m.price_retail,
  m.gtin,
  m.mpn,
  m.line,
  m.importance,
  m.expert_pick,
  m.value_guides_start_date,
  m.detail_ids,
  b.name AS brand_name,
  c.name AS category_name,
  c.full_name AS category_full_name,
  c.path AS category_path
FROM rails.models AS m
JOIN (
  SELECT detail_id, name FROM (
    SELECT detail_id, name,
      ROW_NUMBER() OVER (PARTITION BY detail_id ORDER BY id ASC) AS rn
    FROM rails.brands
  ) WHERE rn = 1
) AS b ON b.detail_id = m.brand_id
JOIN rails.categories AS c ON c.id = m.category_id
WHERE m.state IN ('available', 'pending')
  AND m.category_id = __CATEGORY_ID__
`.trim();

  // -------- config --------

  function loadConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
  function saveConfig(cfg) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg || {}));
  }
  function clearConfig() {
    localStorage.removeItem(CONFIG_KEY);
    localStorage.removeItem(SESSION_KEY);
  }
  function loadSession() {
    return localStorage.getItem(SESSION_KEY) || null;
  }
  function saveSession(token) {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  }

  // -------- auth --------

  async function login() {
    const cfg = loadConfig() || {};
    if (cfg.apiKey) {
      // API-key mode: nothing to do, header is sent per request.
      return { mode: 'api-key' };
    }
    if (!cfg.username || !cfg.password) {
      throw new Error('Metabase config missing: set username + password (or apiKey) in the sync overlay.');
    }
    const res = await fetch(PROXY_BASE + '/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: cfg.username, password: cfg.password }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Metabase login failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    if (!data.id) throw new Error('Metabase login response missing id token');
    saveSession(data.id);
    return { mode: 'session' };
  }

  async function ensureAuth() {
    const cfg = loadConfig() || {};
    if (cfg.apiKey) return;
    if (!loadSession()) await login();
  }

  // Quick connectivity + auth check. Hits Metabase's /api/user/current.
  async function testConnection() {
    const res = await request('/api/user/current', { method: 'GET' });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Auth check ${res.status}: ${text.slice(0, 200) || res.statusText}`);
    }
    return res.json();
  }

  function authHeaders() {
    const cfg = loadConfig() || {};
    if (cfg.apiKey) return { 'X-API-KEY': cfg.apiKey };
    const session = loadSession();
    return session ? { 'X-Metabase-Session': session } : {};
  }

  async function request(path, init = {}, { retried = false } = {}) {
    await ensureAuth();
    const headers = {
      'content-type': 'application/json',
      ...(init.headers || {}),
      ...authHeaders(),
    };
    const res = await fetch(PROXY_BASE + path, { ...init, headers });
    if (res.status === 401 && !retried) {
      saveSession(null);
      return request(path, init, { retried: true });
    }
    return res;
  }

  // -------- query execution --------

  // Streams /api/dataset/json for full result sets (no row cap).
  // Returns parsed JSON array of rows.
  async function runNativeQuery(sql) {
    const body = {
      database: DB_ID,
      type: 'native',
      native: { query: sql },
    };
    // /api/dataset/json wants the payload as a single form field `query`.
    // Sending JSON directly returns 400 ("missing required key, received: nil").
    const res = await request('/api/dataset/json', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'query=' + encodeURIComponent(JSON.stringify(body)),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Metabase query failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return res.json();
  }

  // -------- public queries --------

  async function fetchSports() {
    const rows = await runNativeQuery(SPORTS_SQL);
    return rows.map((r) => ({
      id: String(r.id),
      name: r.name,
      path: r.path,
    }));
  }

  async function fetchRelatableCategories() {
    const rows = await runNativeQuery(CATEGORIES_SQL);
    return rows.map((r) => ({
      id: String(r.id),
      name: r.name,
      fullName: r.full_name,
      path: r.path,
      sportId: r.sport_id == null ? null : String(r.sport_id),
    }));
  }

  async function fetchModelsForCategory(categoryId) {
    const id = parseInt(categoryId, 10);
    if (!Number.isFinite(id)) {
      throw new Error(`Invalid category id: ${categoryId}`);
    }
    const sql = MODELS_SQL_TEMPLATE.replace('__CATEGORY_ID__', String(id));
    const rows = await runNativeQuery(sql);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      state: r.state,
      description: r.description,
      primary_image_url: r.primary_image_url,
      secondary_image_url: r.secondary_image_url,
      position: r.position,
      available_count: r.available_count || 0,
      sold_count: r.sold_count || 0,
      last_90_sold_count: r.last_90_sold_count || 0,
      rank_position: r.rank_position,
      brand_id: r.brand_id,
      category_id: r.category_id,
      synonyms: r.synonyms,
      price_retail: r.price_retail,
      gtin: r.gtin,
      mpn: r.mpn,
      line: r.line,
      importance: r.importance,
      expert_pick: r.expert_pick,
      value_guides_start_date: r.value_guides_start_date,
      detail_ids: r.detail_ids,
      brand_name: r.brand_name,
      category_name: r.category_name,
      category_full_name: r.category_full_name,
      category_path: r.category_path,
    }));
  }

  global.Metabase = {
    loadConfig,
    saveConfig,
    clearConfig,
    loadSession,
    saveSession,
    login,
    ensureAuth,
    testConnection,
    fetchSports,
    fetchRelatableCategories,
    fetchModelsForCategory,
    SPORTS_SQL,
    CATEGORIES_SQL,
    MODELS_SQL_TEMPLATE,
    DB_ID,
  };
})(window);
