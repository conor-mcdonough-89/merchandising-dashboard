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
  CAST(SPLIT(c.path, '/')[OFFSET(0)] AS INT64) AS sport_id,
  COALESCE(rm.ranked_model_count, 0) AS ranked_model_count
FROM rails.categories AS c
LEFT JOIN (
  SELECT category_id, COUNT(*) AS ranked_model_count
  FROM rails.models
  WHERE state = 'available' AND rank_position IS NOT NULL
  GROUP BY category_id
) AS rm ON rm.category_id = c.id
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
      rankedModelCount: r.ranked_model_count || 0,
    }));
  }

  // Lightweight model list for the Model Imagery tool. Sorted by rank_position
  // asc (nulls last), then last_90_sold_count desc.
  const IMAGERY_MODELS_SQL_TEMPLATE = `
SELECT
  m.id,
  m.name,
  m.primary_image_url,
  m.rank_position,
  m.last_90_sold_count
FROM rails.models AS m
WHERE m.state = 'available'
  AND m.category_id = __CATEGORY_ID__
ORDER BY
  CASE WHEN m.rank_position IS NULL THEN 1 ELSE 0 END,
  m.rank_position ASC,
  m.last_90_sold_count DESC
`.trim();

  // Relatable categories under one sport for the iOS Imagery tool.
  // Definition here is "leaf" (no children) rather than has_models=1 -- mobile
  // imagery is a property of the category itself, so categories without
  // sellable models still count. Excludes grouping nodes like
  // "Baseball > Catcher's Equipment" that have child categories underneath.
  const CATEGORY_IMAGERY_SQL_TEMPLATE = `
SELECT
  c.id,
  c.name,
  c.full_name,
  c.mobile_image_url,
  c.facet_count
FROM rails.categories AS c
WHERE CAST(SPLIT(c.path, '/')[OFFSET(0)] AS INT64) = __SPORT_ID__
  AND c.sport = 0
  AND c.available = 1
  AND NOT EXISTS (
    SELECT 1 FROM rails.categories AS child
    WHERE child.parent_id = c.id
  )
ORDER BY c.facet_count DESC
`.trim();

  // Every sport-level root, regardless of whether its subtree has models.
  // Used by the iOS Imagery tool (mobile imagery doesn't require sellable
  // models). Model Cleanup keeps the stricter SPORTS_SQL.
  const ALL_SPORTS_SQL = `
SELECT id, name, path
FROM rails.categories
WHERE sport = 1
ORDER BY position
`.trim();

  async function fetchImageryModelsForCategory(categoryId) {
    const id = parseInt(categoryId, 10);
    if (!Number.isFinite(id)) throw new Error(`Invalid category id: ${categoryId}`);
    const sql = IMAGERY_MODELS_SQL_TEMPLATE.replace('__CATEGORY_ID__', String(id));
    const rows = await runNativeQuery(sql);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      primary_image_url: r.primary_image_url,
      rank_position: r.rank_position,
      last_90_sold_count: r.last_90_sold_count || 0,
    }));
  }

  async function fetchAllSports() {
    const rows = await runNativeQuery(ALL_SPORTS_SQL);
    return rows.map((r) => ({ id: String(r.id), name: r.name, path: r.path }));
  }

  async function fetchCategoryImageryForSport(sportId) {
    const id = parseInt(sportId, 10);
    if (!Number.isFinite(id)) throw new Error(`Invalid sport id: ${sportId}`);
    const sql = CATEGORY_IMAGERY_SQL_TEMPLATE.replace('__SPORT_ID__', String(id));
    const rows = await runNativeQuery(sql);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      mobile_image_url: r.mobile_image_url,
      facet_count: r.facet_count || 0,
    }));
  }

  const BRANDS_FOR_CATEGORY_SQL_TEMPLATE = `
SELECT DISTINCT
  m.brand_id,
  b.name AS brand_name
FROM rails.models AS m
JOIN (
  SELECT detail_id, name FROM (
    SELECT detail_id, name,
      ROW_NUMBER() OVER (PARTITION BY detail_id ORDER BY id ASC) AS rn
    FROM rails.brands
  ) WHERE rn = 1
) AS b ON b.detail_id = m.brand_id
WHERE m.category_id = __CATEGORY_ID__
  AND m.brand_id IS NOT NULL
ORDER BY brand_name
`.trim();

  async function fetchBrandsForCategory(categoryId) {
    const id = parseInt(categoryId, 10);
    if (!Number.isFinite(id)) throw new Error(`Invalid category id: ${categoryId}`);
    const sql = BRANDS_FOR_CATEGORY_SQL_TEMPLATE.replace('__CATEGORY_ID__', String(id));
    const rows = await runNativeQuery(sql);
    return rows.map((r) => ({ id: String(r.brand_id), name: r.brand_name }));
  }

  // Brand filter is optional: omit brandId to pull every version in the
  // category (all brands). The parent model's brand_name is projected so the
  // results table can group/filter by brand client-side.
  function buildModelVersionsSql(categoryId, brandId) {
    const lines = [
      'SELECT',
      '  mv.id,',
      '  mv.name,',
      '  mv.model_id AS parent_model_id,',
      '  m.name      AS parent_model_name,',
      '  m.brand_id  AS brand_id,',
      '  b.name      AS brand_name,',
      '  mv.sku,',
      '  mv.demand,',
      '  mv.demand_code,',
      '  mv.inventory_flow_count,',
      '  mv.price_current_retail,',
      '  mv.primary_image_url',
      'FROM rails.model_versions AS mv',
      'JOIN rails.models AS m ON m.id = mv.model_id',
      'LEFT JOIN (',
      '  SELECT detail_id, name FROM (',
      '    SELECT detail_id, name,',
      '      ROW_NUMBER() OVER (PARTITION BY detail_id ORDER BY id ASC) AS rn',
      '    FROM rails.brands',
      '  ) WHERE rn = 1',
      ') AS b ON b.detail_id = m.brand_id',
      `WHERE m.category_id = ${categoryId}`,
    ];
    if (brandId != null) lines.push(`  AND m.brand_id = ${brandId}`);
    lines.push('ORDER BY mv.inventory_flow_count DESC, mv.demand DESC');
    return lines.join('\n');
  }

  async function fetchModelVersionsForBrandCategory(categoryId, brandId) {
    const cid = parseInt(categoryId, 10);
    if (!Number.isFinite(cid)) throw new Error(`Invalid category id: ${categoryId}`);
    let bid = null;
    if (brandId != null && brandId !== '') {
      bid = parseInt(brandId, 10);
      if (!Number.isFinite(bid)) throw new Error(`Invalid brand id: ${brandId}`);
    }
    const sql = buildModelVersionsSql(cid, bid);
    const rows = await runNativeQuery(sql);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      parent_model_id: r.parent_model_id,
      parent_model_name: r.parent_model_name,
      brand_id: r.brand_id,
      brand_name: r.brand_name,
      sku: r.sku,
      demand: r.demand,
      demand_code: r.demand_code,
      inventory_flow_count: r.inventory_flow_count || 0,
      price_current_retail: r.price_current_retail,
      primary_image_url: r.primary_image_url,
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
    fetchAllSports,
    fetchRelatableCategories,
    fetchModelsForCategory,
    fetchImageryModelsForCategory,
    fetchCategoryImageryForSport,
    fetchBrandsForCategory,
    fetchModelVersionsForBrandCategory,
    runNativeQuery,
    SPORTS_SQL,
    CATEGORIES_SQL,
    MODELS_SQL_TEMPLATE,
    DB_ID,
  };
})(window);
