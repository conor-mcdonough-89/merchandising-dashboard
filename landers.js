// landers.js — Lander query tool.
//
// v1 is read-only. Pulls the `rails.landers` table (light projection) into
// IndexedDB once for fast client-side filter/sort. A second on-demand query
// answers "which landers have a block matching X?" by JOINing
// rails.page_view_block_relations + rails.page_view_blocks. A third query
// lazy-loads a single lander's page_view -> blocks -> tiles tree when the
// operator opens its detail drawer.
//
// All HTTP goes through Metabase.runNativeQuery (metabase.js) — no new auth
// path, no new Edge Function.

(function (global) {
  const ADMIN_BASE = 'https://admin.sidelineswap.com/admin';
  const STATE_KEY = 'merch-landers-ui-state';
  const SYNC_STATES_KEY = 'merch-landers-sync-states';
  const ALL_LANDER_STATES = ['available', 'redirect', 'removed', 'draft'];
  const DEFAULT_SYNC_STATES = ['available'];

  // Match modes for the slug/query/name text filters. `value` is what's stored
  // in `_state.filters[`${key}_mode`]`; `label` is the dropdown text.
  const TEXT_MODES = [
    { value: 'contains', label: 'contains' },
    { value: 'not_contains', label: 'does not contain' },
    { value: 'starts_with', label: 'starts with' },
    { value: 'ends_with', label: 'ends with' },
  ];

  // Engineering's lander bulk-import template — exact column order.
  const LANDER_BULK_IMPORT_HEADERS = [
    'id', 'slug', 'redirect_target_id', 'canonical_id', 'type', 'state',
    'models_category_id', 'page_view_id', 'name', 'title_tag', 'query',
    'synonyms', 'discoverable', 'show_categories', 'show_categories_no_images',
    'description',
  ];

  // Max landers per bulk action. Select-all caps the filtered set at this.
  const LANDER_SELECTION_CAP = 5000;

  // Separate Google Sheet binding so a Landers sheet never clobbers the model
  // tool's bound sheet.
  const LANDERS_BINDING_KEY = (global.Sheets && global.Sheets.LANDERS_BINDING_KEY) || 'merch-landers-sheets-binding';

  // ---- SQL ----

  // Light projection: omit description + synonyms (heavy fields) so the
  // ~180k row sync stays IndexedDB-friendly. Detail drawer pulls those on
  // demand if needed.
  const LANDERS_LIST_SQL_TEMPLATE = `
SELECT
  l.id,
  l.slug,
  l.name,
  l.title_tag,
  l.query,
  l.type,
  l.state,
  l.discoverable,
  l.available_count,
  l.page_view_id,
  l.redirect_target_id
FROM rails.landers AS l
WHERE __STATE_FILTER__
`.trim();

  function buildStateFilter(states) {
    const safe = (states || []).filter((s) => ALL_LANDER_STATES.includes(s));
    if (!safe.length) throw new Error('Select at least one state to sync.');
    return `l.state IN (${safe.map((s) => `'${s}'`).join(', ')})`;
  }

  // Predicate is substituted server-side from a whitelisted column + operator
  // (see buildBlockPredicate). r.web = 1 because the user said the "web"
  // connections are the ones that matter. __TILE_COUNT_CLAUSE__ is either an
  // empty string or `AND b.id IN (...)` restricting to blocks with N tiles.
  const LANDER_IDS_WITH_BLOCK_SQL_TEMPLATE = `
SELECT DISTINCT l.id
FROM rails.landers AS l
JOIN rails.page_view_block_relations AS r ON r.page_view_id = l.page_view_id
JOIN rails.page_view_blocks AS b ON b.id = r.block_id
WHERE r.web = 1
  AND __BLOCK_PREDICATE__
  __TILE_COUNT_CLAUSE__
`.trim();

  // Distinct lander ids that have at least one web-attached block, regardless
  // of block content. Used by the has_block toggle.
  const LANDER_IDS_WITH_ANY_BLOCK_SQL = `
SELECT DISTINCT l.id
FROM rails.landers AS l
JOIN rails.page_view_block_relations AS r ON r.page_view_id = l.page_view_id
WHERE r.web = 1
`.trim();

  // One lander's full tree. Returns the blocks row-per-block (no tile fan-out)
  // — tiles are fetched in a second pass keyed by block_id so we don't pay an
  // N×M row blowup.
  const LANDER_BLOCKS_SQL_TEMPLATE = `
SELECT
  r.id          AS relation_id,
  r.position    AS block_position,
  r.ios, r.android, r.web, r.mobile,
  b.id          AS block_id,
  b.name        AS block_name,
  b.title       AS block_title,
  b.layout      AS block_layout,
  b.data_type   AS block_data_type,
  b.query       AS block_query,
  b.destination AS block_destination,
  b.cta         AS block_cta,
  b.active      AS block_active
FROM rails.page_view_block_relations AS r
JOIN rails.page_view_blocks AS b ON b.id = r.block_id
WHERE r.page_view_id = __PAGE_VIEW_ID__
ORDER BY r.position ASC
`.trim();

  const BLOCK_TILES_SQL_TEMPLATE = `
SELECT
  at.id         AS attachment_id,
  at.block_id   AS block_id,
  at.position   AS tile_position,
  t.id          AS tile_id,
  t.title       AS tile_title,
  t.subtitle    AS tile_subtitle,
  t.destination AS tile_destination,
  t.image_url   AS tile_image_url
FROM rails.attachable_tiles AS at
JOIN rails.tiles AS t ON t.id = at.tile_id
WHERE at.block_id IN (__BLOCK_IDS__)
ORDER BY at.block_id, at.position ASC
`.trim();

  // Landers whose linked category is removed. Categories join to landers via
  // categories.primary_lander_id; there is no state column, so available = 0
  // (INT64 boolean) is "removed".
  const LANDER_REMOVED_CATEGORIES_SQL = `
SELECT c.primary_lander_id AS lander_id
FROM rails.categories AS c
WHERE c.primary_lander_id IS NOT NULL AND c.available = 0
`.trim();

  // Landers whose linked model is removed or merged. Models join via
  // models.primary_lander_id. Only "interesting" rows are returned so the
  // result stays small. A non-null merge_target_id (or state='merged') = merged.
  const LANDER_MODEL_STATUS_SQL = `
SELECT m.primary_lander_id AS lander_id, m.state AS state, m.merge_target_id AS merge_target_id
FROM rails.models AS m
WHERE m.primary_lander_id IS NOT NULL
  AND (m.state = 'removed' OR m.state = 'merged' OR m.merge_target_id IS NOT NULL)
`.trim();

  // Full template-column projection for a set of selected lander ids. Ids are
  // integers from our own cache; we coerce + validate to integers before
  // interpolation (same defense-in-depth as the block predicate — no template
  // tags). The IN-list is chunked by the caller to stay within SQL limits.
  const LANDER_TEMPLATE_FIELDS_SQL_TEMPLATE = `
SELECT
  l.id,
  l.slug,
  l.redirect_target_id,
  l.canonical_id,
  l.type,
  l.state,
  l.models_category_id,
  l.page_view_id,
  l.name,
  l.title_tag,
  l.query,
  l.synonyms,
  l.discoverable,
  l.show_categories,
  l.show_categories_no_images,
  l.description
FROM rails.landers AS l
WHERE l.id IN (__IDS__)
`.trim();

  // ---- SQL builders ----

  const BLOCK_PREDICATE_COLUMNS = new Set(['layout', 'data_type', 'name', 'title', 'destination']);
  const BLOCK_PREDICATE_OPS = new Set(['equals', 'contains']);
  const NUM_OPS = new Set(['>', '<', '>=', '<=', '=', 'between']);

  // Builds the WHERE fragment for the block-composition filter. Column +
  // operator come from a whitelist; the user-supplied value is escaped for
  // single quotes. Same defense-in-depth pattern the merch tool uses for
  // category-id interpolation (see metabase.js:54-94 comment).
  function buildBlockPredicate({ column, op, value }) {
    if (!BLOCK_PREDICATE_COLUMNS.has(column)) throw new Error('Invalid block filter column: ' + column);
    if (!BLOCK_PREDICATE_OPS.has(op)) throw new Error('Invalid block filter operator: ' + op);
    const v = String(value || '').replace(/'/g, "''");
    if (!v) throw new Error('Block filter value cannot be empty.');
    if (op === 'equals') return `b.${column} = '${v}'`;
    return `LOWER(b.${column}) LIKE LOWER('%${v}%')`;
  }

  // Builds the `AND b.id IN (...)` clause restricting to blocks whose
  // attachable_tiles count satisfies the predicate. Returns '' when tile_count
  // is null. Op and value are whitelisted/parsed before interpolation.
  function buildTileCountClause(pred) {
    if (!pred || !pred.op) return '';
    if (!NUM_OPS.has(pred.op)) throw new Error('Invalid tile_count op: ' + pred.op);
    let having;
    if (pred.op === 'between') {
      if (!Array.isArray(pred.value) || pred.value.length !== 2) throw new Error('tile_count between requires [lo, hi]');
      const lo = parseInt(pred.value[0], 10);
      const hi = parseInt(pred.value[1], 10);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error('tile_count between requires integers');
      having = `COUNT(*) BETWEEN ${lo} AND ${hi}`;
    } else {
      const n = parseInt(pred.value, 10);
      if (!Number.isFinite(n)) throw new Error('tile_count value must be a number');
      having = `COUNT(*) ${pred.op} ${n}`;
    }
    return `AND b.id IN (
  SELECT at.block_id FROM rails.attachable_tiles AS at
  GROUP BY at.block_id
  HAVING ${having}
)`;
  }

  // Client-side numeric predicate against a lander row's available_count.
  function numericMatches(pred, n) {
    if (!pred) return true;
    if (pred.op === 'between') {
      if (!Array.isArray(pred.value)) return true;
      const [lo, hi] = pred.value.map(Number);
      return n >= lo && n <= hi;
    }
    const v = Number(pred.value);
    if (!Number.isFinite(v)) return true;
    switch (pred.op) {
      case '>': return n > v;
      case '<': return n < v;
      case '>=': return n >= v;
      case '<=': return n <= v;
      case '=': return n === v;
      default: return true;
    }
  }

  function summarizeNumPred(pred, label) {
    if (!pred) return null;
    if (pred.op === 'between' && Array.isArray(pred.value)) {
      return `${label} between ${pred.value[0]}–${pred.value[1]}`;
    }
    return `${label} ${pred.op} ${pred.value}`;
  }

  function normalizeLander(r) {
    return {
      id: r.id,
      slug: r.slug || '',
      name: r.name || '',
      title_tag: r.title_tag || '',
      query: r.query || '',
      type: r.type || '',
      state: r.state || '',
      discoverable: r.discoverable === 1 || r.discoverable === true ? 1 : 0,
      available_count: r.available_count == null ? 0 : Number(r.available_count),
      page_view_id: r.page_view_id == null ? null : Number(r.page_view_id),
      redirect_target_id: r.redirect_target_id == null ? null : Number(r.redirect_target_id),
      // Linked category/model status (joined via primary_lander_id at sync).
      cat_removed: 0,
      model_removed: 0,
      model_merged: 0,
    };
  }

  // Fetch the removed-category and removed/merged-model sets keyed by the
  // lander each is the primary for. Merged wins over removed for a model.
  async function fetchLinkedStatus(onProgress) {
    if (onProgress) onProgress('Checking linked categories…');
    const catRows = await Metabase.runNativeQuery(LANDER_REMOVED_CATEGORIES_SQL);
    const catRemoved = new Set(catRows.map((r) => Number(r.lander_id)));
    if (onProgress) onProgress('Checking linked models…');
    const modelRows = await Metabase.runNativeQuery(LANDER_MODEL_STATUS_SQL);
    const modelRemoved = new Set();
    const modelMerged = new Set();
    for (const m of modelRows) {
      const id = Number(m.lander_id);
      const state = (m.state == null ? '' : String(m.state));
      const mergeId = m.merge_target_id;
      const merged = state === 'merged' || (mergeId != null && mergeId !== '');
      if (merged) modelMerged.add(id);
      else if (state === 'removed') modelRemoved.add(id);
    }
    return { catRemoved, modelRemoved, modelMerged };
  }

  async function syncAllLanders(states, onProgress) {
    const sql = LANDERS_LIST_SQL_TEMPLATE.replace('__STATE_FILTER__', buildStateFilter(states));
    if (onProgress) onProgress('Querying Metabase…');
    const rows = await Metabase.runNativeQuery(sql);
    // Linked category/model status is best-effort: if these joins fail, landers
    // still sync without the badges/filter.
    let status = { catRemoved: new Set(), modelRemoved: new Set(), modelMerged: new Set() };
    try {
      status = await fetchLinkedStatus(onProgress);
    } catch (_) { /* badges simply won't show */ }
    if (onProgress) onProgress(`Saving ${rows.length.toLocaleString()} landers to IndexedDB…`);
    await Storage.clearLanders();
    // Chunked writes keep individual transactions small.
    const CHUNK = 5000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK).map((r) => {
        const l = normalizeLander(r);
        const id = Number(l.id);
        l.cat_removed = status.catRemoved.has(id) ? 1 : 0;
        l.model_removed = status.modelRemoved.has(id) ? 1 : 0;
        l.model_merged = status.modelMerged.has(id) ? 1 : 0;
        return l;
      });
      await Storage.putLanders(slice);
      if (onProgress) onProgress(`Saved ${Math.min(i + CHUNK, rows.length).toLocaleString()} / ${rows.length.toLocaleString()}…`);
    }
    await Storage.saveLandersMeta({ syncedAt: new Date().toISOString(), count: rows.length, states });
    return rows.length;
  }

  function loadSyncStates() {
    try {
      const raw = localStorage.getItem(SYNC_STATES_KEY);
      if (!raw) return DEFAULT_SYNC_STATES.slice();
      const arr = JSON.parse(raw);
      const safe = Array.isArray(arr) ? arr.filter((s) => ALL_LANDER_STATES.includes(s)) : [];
      return safe.length ? safe : DEFAULT_SYNC_STATES.slice();
    } catch (_) { return DEFAULT_SYNC_STATES.slice(); }
  }
  function saveSyncStates(states) {
    localStorage.setItem(SYNC_STATES_KEY, JSON.stringify(states || []));
  }

  async function fetchLanderIdsWithBlock(filter) {
    const predicate = buildBlockPredicate(filter);
    const tileClause = buildTileCountClause(filter.tile_count);
    const sql = LANDER_IDS_WITH_BLOCK_SQL_TEMPLATE
      .replace('__BLOCK_PREDICATE__', predicate)
      .replace('__TILE_COUNT_CLAUSE__', tileClause);
    const rows = await Metabase.runNativeQuery(sql);
    const set = new Set();
    for (const r of rows) set.add(Number(r.id));
    return set;
  }

  async function fetchLanderIdsWithAnyBlock() {
    const rows = await Metabase.runNativeQuery(LANDER_IDS_WITH_ANY_BLOCK_SQL);
    const set = new Set();
    for (const r of rows) set.add(Number(r.id));
    return set;
  }

  async function fetchLanderDetail(lander) {
    if (!lander.page_view_id) return { blocks: [] };
    const blocksSql = LANDER_BLOCKS_SQL_TEMPLATE.replace('__PAGE_VIEW_ID__', String(Number(lander.page_view_id)));
    const blockRows = await Metabase.runNativeQuery(blocksSql);
    if (!blockRows.length) return { blocks: [] };
    const blockIds = blockRows.map((b) => Number(b.block_id)).filter(Number.isFinite);
    const tilesSql = BLOCK_TILES_SQL_TEMPLATE.replace('__BLOCK_IDS__', blockIds.join(','));
    const tileRows = blockIds.length ? await Metabase.runNativeQuery(tilesSql) : [];
    const tilesByBlock = new Map();
    for (const t of tileRows) {
      const arr = tilesByBlock.get(Number(t.block_id)) || [];
      arr.push(t);
      tilesByBlock.set(Number(t.block_id), arr);
    }
    const blocks = blockRows.map((b) => ({ ...b, tiles: tilesByBlock.get(Number(b.block_id)) || [] }));
    return { blocks };
  }

  // ---- UI state ----

  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(STATE_KEY) || '{}') || {};
    } catch (_) { return {}; }
  }
  function saveState(s) {
    localStorage.setItem(STATE_KEY, JSON.stringify(s || {}));
  }

  let _state = {
    filters: {
      slug: '', query: '', name: '', type: 'all', state: 'all', discoverable: 'all',
      // Per-text-field match mode: 'contains' | 'not_contains'.
      slug_mode: 'contains', query_mode: 'contains', name_mode: 'contains',
      available_count: null, // { op, value } or null
      has_page_view: 'any',  // 'any' | 'has' | 'none'
      linked: 'any',         // 'any' | 'cat_removed' | 'model_removed' | 'model_merged' | 'any_flag'
    },
    block: { enabled: false, column: 'layout', op: 'equals', value: '', tile_count: null },
    has_block: 'any', // 'any' | 'has' | 'none'
    sort: { col: 'available_count', dir: 'desc' },
  };

  // Sets of lander ids restricted by server-side queries. `null` means no
  // constraint applied yet — these live outside _state because they're
  // server-derived and not worth persisting.
  let _blockIdSet = null;
  let _hasBlockIdSet = null;
  let _lastChatSpec = null;
  let _allLanders = null;

  // Bulk-action state. `_selectedLanderIds` is the operator's current checkbox
  // selection; `_landerSheetMap` mirrors the lander_sheet IndexedDB store so
  // queued rows get an inline diff badge; `_lastFilteredIds` is the full
  // filtered id list (table display is capped, selection is not).
  let _selectedLanderIds = new Set();
  let _landerSheetMap = new Map();
  let _lastFilteredIds = [];

  function landerToast(msg, kind = '') {
    const wrap = document.getElementById('toasts');
    if (!wrap) return;
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => { t.remove(); }, 4500);
  }

  function landerBinding() {
    return (global.Sheets && Sheets.loadBinding) ? Sheets.loadBinding(LANDERS_BINDING_KEY) : null;
  }

  async function refreshLanderSheetMap() {
    try {
      const entries = await Storage.listLanderSheetEntries();
      _landerSheetMap = new Map(entries.map((e) => [Number(e.id), e]));
    } catch (_) {
      _landerSheetMap = new Map();
    }
  }

  function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  function serializeArr(v) {
    if (Array.isArray(v)) return v.join(';');
    return v == null ? '' : v;
  }

  // Fetch every template column for the selected ids, chunking the IN-list.
  async function fetchLanderTemplateFields(ids) {
    const valid = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const map = new Map();
    for (const part of chunk(valid, 1000)) {
      const sql = LANDER_TEMPLATE_FIELDS_SQL_TEMPLATE.replace('__IDS__', part.join(','));
      const rows = await Metabase.runNativeQuery(sql);
      for (const r of rows) map.set(Number(r.id), r);
    }
    return map;
  }

  // Build the bulk-import row object: every column from the DB record, with the
  // operator's whitelisted changes (state, discoverable) layered on top.
  function buildLanderRow(fields, changes) {
    const row = Object.fromEntries(LANDER_BULK_IMPORT_HEADERS.map((h) => [h, '']));
    const s = fields || {};
    for (const h of LANDER_BULK_IMPORT_HEADERS) row[h] = serializeArr(s[h]);
    if (changes && changes.state != null) row.state = changes.state;
    if (changes && changes.discoverable != null) row.discoverable = changes.discoverable ? 1 : 0;
    return row;
  }

  function buildLanderValues(fields, changes) {
    const r = buildLanderRow(fields, changes);
    return LANDER_BULK_IMPORT_HEADERS.map((h) => (r[h] == null ? '' : r[h]));
  }

  function computeChangedLanderColumns(changes) {
    const idx = (n) => LANDER_BULK_IMPORT_HEADERS.indexOf(n);
    const out = [];
    if (changes && changes.state != null) out.push(idx('state'));
    if (changes && changes.discoverable != null) out.push(idx('discoverable'));
    return out.filter((i) => i >= 0);
  }

  function adminUrl(entity, id) {
    if (id == null) return null;
    // Map our internal entity names to admin paths. The user's message had
    // typos in the URLs; these match Rails admin conventions for the table
    // names noted in CLAUDE.md.
    const paths = {
      lander: 'landers',
      page_view: 'page_views',
      block: 'page_view_blocks',
      tile: 'tiles',
      category: 'categories',
    };
    const p = paths[entity];
    if (!p) return null;
    return `${ADMIN_BASE}/${p}/${id}`;
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replaceAll('"', '&quot;');
  }
  function formatRelative(iso) {
    if (!iso) return 'never';
    const diff = Date.now() - new Date(iso).getTime();
    const s = Math.round(diff / 1000);
    if (s < 60) return `${s}s ago`;
    const min = Math.round(s / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 48) return `${hr}h ago`;
    return `${Math.round(hr / 24)}d ago`;
  }

  // ---- render ----

  async function render() {
    const saved = loadState();
    if (saved.filters) Object.assign(_state.filters, saved.filters);
    if (saved.block) Object.assign(_state.block, saved.block);
    if (saved.sort) Object.assign(_state.sort, saved.sort);

    const main = document.getElementById('main');
    const meta = await Storage.loadLandersMeta();
    _allLanders = await Storage.listLanders();
    await refreshLanderSheetMap();

    main.innerHTML = `
      <div class="landers-tool">
        <h2>Landing Page Query</h2>
        <p class="imagery-subtitle">
          Query the <code>landers</code> table (and attached page_views / blocks / tiles)
          without writing SQL. v1 is read-only — click a row to inspect its tree and deep-link into admin.
        </p>

        <div class="landers-sync-bar">
          <button class="primary" id="landers-sync-btn">${_allLanders.length ? 'Re-sync landers' : 'Sync landers from Metabase'}</button>
          <span class="muted small" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
            <span>Include states:</span>
            ${ALL_LANDER_STATES.map((s) => `
              <label class="row-flex" style="gap:4px;cursor:pointer;">
                <input type="checkbox" class="lf-sync-state" value="${s}"${loadSyncStates().includes(s) ? ' checked' : ''}>
                <span>${s}</span>
              </label>
            `).join('')}
          </span>
          <span class="muted small" id="landers-sync-status">
            ${meta ? `${_allLanders.length.toLocaleString()} landers (${(meta.states || ['?']).join(', ')}) · synced ${formatRelative(meta.syncedAt)}` : 'No landers synced yet.'}
          </span>
        </div>

        ${_allLanders.length ? renderChatHtml() : ''}
        ${_allLanders.length ? renderFiltersHtml() : ''}
        <div id="landers-results"></div>
        <div id="lander-detail" class="lander-detail hidden"></div>
      </div>
    `;

    document.getElementById('landers-sync-btn').addEventListener('click', onSyncClick);
    document.querySelectorAll('.lf-sync-state').forEach((cb) => {
      cb.addEventListener('change', () => {
        const checked = Array.from(document.querySelectorAll('.lf-sync-state'))
          .filter((c) => c.checked).map((c) => c.value);
        saveSyncStates(checked);
      });
    });
    if (_allLanders.length) {
      bindChatHandlers();
      bindFilterHandlers();
      renderResults();
    }
  }

  function renderChatHtml() {
    return `
      <div class="landers-chat">
        <div class="landers-chat-row">
          <input type="text" id="lf-chat-input" placeholder="Ask in plain English — e.g. &quot;available landers with a top-models block and 'model' in the query&quot;">
          <button class="primary" id="lf-chat-ask">Ask</button>
          <span id="lf-chat-status" class="muted small"></span>
        </div>
        <div id="lf-chat-pill" class="landers-chat-pill hidden"></div>
      </div>
    `;
  }

  // A text filter is a match-mode select paired with its input. `key` is the
  // filter id ('slug' | 'query' | 'name'), `label` the placeholder noun. Mode
  // lives at `_state.filters[`${key}_mode`]` and is one of TEXT_MODES.
  function textFilterHtml(key, label, value, mode) {
    const m = TEXT_MODES.some((o) => o.value === mode) ? mode : 'contains';
    const opts = TEXT_MODES.map((o) =>
      `<option value="${o.value}"${o.value === m ? ' selected' : ''}>${o.label}</option>`).join('');
    return `
      <span class="lf-text-filter">
        <select id="lf-${key}-mode" class="lf-text-mode">${opts}</select>
        <input type="text" id="lf-${key}" placeholder="${escapeAttr(label)}…" value="${escapeAttr(value)}">
      </span>
    `;
  }

  function renderFiltersHtml() {
    const f = _state.filters;
    const b = _state.block;
    return `
      <div class="landers-filters">
        <div class="landers-filter-row">
          ${textFilterHtml('slug', 'Slug', f.slug, f.slug_mode)}
          ${textFilterHtml('query', 'Query', f.query, f.query_mode)}
          ${textFilterHtml('name', 'Name', f.name, f.name_mode)}
          <select id="lf-type">
            <option value="all">All types</option>
          </select>
          <select id="lf-state">
            <option value="all"${f.state === 'all' ? ' selected' : ''}>All states</option>
            ${ALL_LANDER_STATES.map((s) => `<option value="${s}"${f.state === s ? ' selected' : ''}>${s}</option>`).join('')}
          </select>
          <select id="lf-discoverable">
            <option value="all"${f.discoverable === 'all' ? ' selected' : ''}>Discoverable: any</option>
            <option value="1"${f.discoverable === '1' ? ' selected' : ''}>Discoverable only</option>
            <option value="0"${f.discoverable === '0' ? ' selected' : ''}>Undiscoverable only</option>
          </select>
          <select id="lf-linked" title="Filter by the linked category/model status (joined via primary_lander_id)">
            <option value="any"${f.linked === 'any' ? ' selected' : ''}>Linked: any</option>
            <option value="any_flag"${f.linked === 'any_flag' ? ' selected' : ''}>Any removed/merged</option>
            <option value="cat_removed"${f.linked === 'cat_removed' ? ' selected' : ''}>Category removed</option>
            <option value="model_removed"${f.linked === 'model_removed' ? ' selected' : ''}>Model removed</option>
            <option value="model_merged"${f.linked === 'model_merged' ? ' selected' : ''}>Model merged</option>
          </select>
        </div>
        <div class="landers-filter-row">
          <label class="row-flex" style="gap:6px;cursor:pointer;">
            <input type="checkbox" id="lf-block-enabled"${b.enabled ? ' checked' : ''}>
            <span>Has a block where</span>
          </label>
          <select id="lf-block-col">
            <option value="layout"${b.column === 'layout' ? ' selected' : ''}>layout</option>
            <option value="data_type"${b.column === 'data_type' ? ' selected' : ''}>data_type</option>
            <option value="name"${b.column === 'name' ? ' selected' : ''}>name</option>
            <option value="title"${b.column === 'title' ? ' selected' : ''}>title</option>
            <option value="destination"${b.column === 'destination' ? ' selected' : ''}>destination</option>
          </select>
          <select id="lf-block-op">
            <option value="equals"${b.op === 'equals' ? ' selected' : ''}>equals</option>
            <option value="contains"${b.op === 'contains' ? ' selected' : ''}>contains</option>
          </select>
          <input type="text" id="lf-block-val" placeholder="value (e.g. top_models)" value="${escapeAttr(b.value)}" style="flex:1;">
          <button class="ghost" id="lf-block-apply">Apply block filter</button>
          <span id="lf-block-status" class="muted small"></span>
        </div>
        <div class="landers-filter-row">
          <span class="muted small" id="landers-count"></span>
          <div class="spacer"></div>
          <button class="ghost" id="lf-clear">Clear filters</button>
        </div>
      </div>
    `;
  }

  function bindFilterHandlers() {
    // Populate the type dropdown from synced data.
    const typeSel = document.getElementById('lf-type');
    const types = Array.from(new Set(_allLanders.map((l) => l.type).filter(Boolean))).sort();
    for (const t of types) {
      const o = document.createElement('option');
      o.value = t; o.textContent = t;
      if (_state.filters.type === t) o.selected = true;
      typeSel.appendChild(o);
    }

    const debouncedRender = debounce(() => { persistAndRender(); }, 150);
    ['lf-slug', 'lf-query', 'lf-name'].forEach((id) => {
      document.getElementById(id).addEventListener('input', (e) => {
        const key = id.replace('lf-', '');
        _state.filters[key] = e.target.value;
        debouncedRender();
      });
    });
    ['lf-slug-mode', 'lf-query-mode', 'lf-name-mode'].forEach((id) => {
      document.getElementById(id).addEventListener('change', (e) => {
        const key = id.replace('lf-', '').replace('-mode', '') + '_mode';
        _state.filters[key] = e.target.value;
        persistAndRender();
      });
    });
    ['lf-type', 'lf-state', 'lf-discoverable', 'lf-linked'].forEach((id) => {
      document.getElementById(id).addEventListener('change', (e) => {
        const key = id.replace('lf-', '');
        _state.filters[key] = e.target.value;
        persistAndRender();
      });
    });

    document.getElementById('lf-block-enabled').addEventListener('change', (e) => {
      _state.block.enabled = e.target.checked;
      if (!e.target.checked) {
        _blockIdSet = null;
        document.getElementById('lf-block-status').textContent = '';
      }
      persistAndRender();
    });
    document.getElementById('lf-block-col').addEventListener('change', (e) => { _state.block.column = e.target.value; });
    document.getElementById('lf-block-op').addEventListener('change', (e) => { _state.block.op = e.target.value; });
    document.getElementById('lf-block-val').addEventListener('input', (e) => { _state.block.value = e.target.value; });
    document.getElementById('lf-block-apply').addEventListener('click', applyBlockFilter);

    document.getElementById('lf-clear').addEventListener('click', () => {
      _state.filters = {
        slug: '', query: '', name: '', type: 'all', state: 'all', discoverable: 'all',
        slug_mode: 'contains', query_mode: 'contains', name_mode: 'contains',
        available_count: null, has_page_view: 'any', linked: 'any',
      };
      _state.block = { enabled: false, column: 'layout', op: 'equals', value: '', tile_count: null };
      _state.has_block = 'any';
      _blockIdSet = null;
      _hasBlockIdSet = null;
      _lastChatSpec = null;
      saveState(_state);
      render();
    });
  }

  // ---- Chat translation ----

  async function postChat(message) {
    const known_states = Array.from(new Set(_allLanders.map((l) => l.state).filter(Boolean)));
    const known_types = Array.from(new Set(_allLanders.map((l) => l.type).filter(Boolean))).slice(0, 30);
    const res = await fetch('/api/landers/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, known_states, known_types }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function bindChatHandlers() {
    const input = document.getElementById('lf-chat-input');
    const btn = document.getElementById('lf-chat-ask');
    if (!input || !btn) return;
    btn.addEventListener('click', () => askChat());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); askChat(); }
    });
  }

  async function askChat() {
    const input = document.getElementById('lf-chat-input');
    const status = document.getElementById('lf-chat-status');
    const btn = document.getElementById('lf-chat-ask');
    const msg = (input.value || '').trim();
    if (!msg) { input.focus(); return; }
    status.textContent = 'Translating…';
    status.style.color = '';
    btn.disabled = true;
    try {
      const spec = await postChat(msg);
      _lastChatSpec = spec;
      renderChatPill(spec);
      await applyChatSpec(spec);
      status.textContent = '';
    } catch (e) {
      status.textContent = 'Failed: ' + e.message;
      status.style.color = 'var(--red)';
    } finally {
      btn.disabled = false;
    }
  }

  function renderChatPill(spec) {
    const pill = document.getElementById('lf-chat-pill');
    if (!pill) return;
    if (!spec) { pill.classList.add('hidden'); pill.innerHTML = ''; return; }
    const summary = summarizeSpec(spec);
    pill.classList.remove('hidden');
    pill.innerHTML = `
      <div class="landers-chat-pill-body">
        <strong>Applied:</strong> ${escapeHtml(spec.explanation || '(no explanation)')}
        ${summary ? `<div class="muted small">${escapeHtml(summary)}</div>` : ''}
      </div>
      <button class="ghost" id="lf-chat-clear">Clear</button>
    `;
    const clearBtn = document.getElementById('lf-chat-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      _lastChatSpec = null;
      document.getElementById('lf-clear').click();
    });
  }

  function summarizeSpec(spec) {
    const parts = [];
    const f = spec.filters || {};
    const TEXT_OPS = [
      { suffix: 'contains', verb: 'contains' },
      { suffix: 'not_contains', verb: 'does not contain' },
      { suffix: 'starts_with', verb: 'starts with' },
      { suffix: 'ends_with', verb: 'ends with' },
    ];
    for (const field of ['slug', 'query', 'name']) {
      for (const { suffix, verb } of TEXT_OPS) {
        const val = f[`${field}_${suffix}`];
        if (val) parts.push(`${field} ${verb} "${val}"`);
      }
    }
    if (f.type) parts.push(`type=${f.type}`);
    if (f.state) parts.push(`state=${f.state}`);
    if (f.discoverable === true) parts.push('discoverable');
    if (f.discoverable === false) parts.push('undiscoverable');
    const ac = summarizeNumPred(f.available_count, 'available_count');
    if (ac) parts.push(ac);
    if (f.has_page_view === 'has') parts.push('has page_view');
    if (f.has_page_view === 'none') parts.push('no page_view');
    const linkedLabels = {
      cat_removed: 'linked category removed',
      model_removed: 'linked model removed',
      model_merged: 'linked model merged',
      any_flag: 'linked removed/merged',
    };
    if (f.linked && linkedLabels[f.linked]) parts.push(linkedLabels[f.linked]);
    const b = spec.block || {};
    if (b.enabled) {
      parts.push(`block.${b.column} ${b.op} "${b.value}"`);
      const tc = summarizeNumPred(b.tile_count, 'tile_count');
      if (tc) parts.push(tc);
    }
    if (spec.has_block === 'has') parts.push('has any block');
    if (spec.has_block === 'none') parts.push('no blocks');
    return parts.join(' · ');
  }

  // Translates the LLM filter spec back onto the filter UI and fires any
  // server-side queries the spec implies (block filter, has-block).
  async function applyChatSpec(spec) {
    const f = spec.filters || {};
    // Each text field is single-mode in the UI, but the spec can carry several
    // operators. Pick the first present in this precedence order.
    const SPEC_MODES = [
      { suffix: 'not_contains', mode: 'not_contains' },
      { suffix: 'starts_with', mode: 'starts_with' },
      { suffix: 'ends_with', mode: 'ends_with' },
      { suffix: 'contains', mode: 'contains' },
    ];
    const applyText = (key) => {
      for (const { suffix, mode } of SPEC_MODES) {
        const val = f[`${key}_${suffix}`];
        if (val) { _state.filters[key] = val; _state.filters[`${key}_mode`] = mode; return; }
      }
      _state.filters[key] = '';
      _state.filters[`${key}_mode`] = 'contains';
    };
    applyText('slug');
    applyText('query');
    applyText('name');
    _state.filters.type = f.type || 'all';
    _state.filters.state = f.state || 'all';
    if (f.discoverable === true) _state.filters.discoverable = '1';
    else if (f.discoverable === false) _state.filters.discoverable = '0';
    else _state.filters.discoverable = 'all';
    _state.filters.available_count = f.available_count || null;
    _state.filters.has_page_view = f.has_page_view || 'any';
    _state.filters.linked = f.linked || 'any';

    const b = spec.block || {};
    _state.block.enabled = !!b.enabled;
    if (b.enabled) {
      _state.block.column = b.column;
      _state.block.op = b.op;
      _state.block.value = b.value;
      _state.block.tile_count = b.tile_count || null;
    } else {
      _state.block.tile_count = null;
      _blockIdSet = null;
    }
    _state.has_block = spec.has_block || 'any';
    saveState(_state);

    // Re-render the filter inputs so the new state is visible. Then re-bind.
    refreshFilterInputs();

    // Fire server-side queries.
    if (_state.block.enabled) {
      try {
        document.getElementById('lf-block-status').textContent = 'Running…';
        _blockIdSet = await fetchLanderIdsWithBlock(_state.block);
        document.getElementById('lf-block-status').textContent = `${_blockIdSet.size.toLocaleString()} matching landers.`;
      } catch (e) {
        _blockIdSet = null;
        document.getElementById('lf-block-status').textContent = 'Block filter failed: ' + e.message;
        document.getElementById('lf-block-status').style.color = 'var(--red)';
      }
    }
    if (_state.has_block === 'has' || _state.has_block === 'none') {
      if (!_hasBlockIdSet) {
        try {
          _hasBlockIdSet = await fetchLanderIdsWithAnyBlock();
        } catch (e) {
          _hasBlockIdSet = null;
        }
      }
    }
    renderResults();
  }

  // Re-syncs the filter <input>/<select> elements with the current _state
  // values. Used after applyChatSpec mutates state outside the manual UI path.
  function refreshFilterInputs() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('lf-slug', _state.filters.slug);
    set('lf-query', _state.filters.query);
    set('lf-name', _state.filters.name);
    set('lf-slug-mode', _state.filters.slug_mode || 'contains');
    set('lf-query-mode', _state.filters.query_mode || 'contains');
    set('lf-name-mode', _state.filters.name_mode || 'contains');
    set('lf-type', _state.filters.type);
    set('lf-state', _state.filters.state);
    set('lf-discoverable', _state.filters.discoverable);
    set('lf-linked', _state.filters.linked || 'any');
    const be = document.getElementById('lf-block-enabled');
    if (be) be.checked = _state.block.enabled;
    set('lf-block-col', _state.block.column);
    set('lf-block-op', _state.block.op);
    set('lf-block-val', _state.block.value);
  }

  function persistAndRender() {
    saveState(_state);
    renderResults();
  }

  async function applyBlockFilter() {
    const status = document.getElementById('lf-block-status');
    if (!_state.block.value || !_state.block.value.trim()) {
      status.textContent = 'Enter a value first.';
      status.style.color = 'var(--red)';
      return;
    }
    _state.block.enabled = true;
    document.getElementById('lf-block-enabled').checked = true;
    status.textContent = 'Running…';
    status.style.color = '';
    try {
      _blockIdSet = await fetchLanderIdsWithBlock(_state.block);
      status.textContent = `${_blockIdSet.size.toLocaleString()} matching landers.`;
      persistAndRender();
    } catch (e) {
      status.textContent = 'Failed: ' + e.message;
      status.style.color = 'var(--red)';
    }
  }

  // True when `value` satisfies `mode` against `needle`. An empty needle never
  // constrains. `mode` is one of TEXT_MODES (defaults to contains).
  function textMatches(value, needle, mode) {
    if (!needle) return true;
    const v = (value || '').toLowerCase();
    switch (mode) {
      case 'not_contains': return !v.includes(needle);
      case 'starts_with': return v.startsWith(needle);
      case 'ends_with': return v.endsWith(needle);
      default: return v.includes(needle);
    }
  }

  function filterLanders() {
    const f = _state.filters;
    const slug = f.slug.trim().toLowerCase();
    const query = f.query.trim().toLowerCase();
    const name = f.name.trim().toLowerCase();
    const out = [];
    for (const l of _allLanders) {
      if (!textMatches(l.slug, slug, f.slug_mode)) continue;
      if (!textMatches(l.query, query, f.query_mode)) continue;
      if (!textMatches(l.name, name, f.name_mode)) continue;
      if (f.type !== 'all' && l.type !== f.type) continue;
      if (f.state !== 'all' && l.state !== f.state) continue;
      if (f.discoverable !== 'all' && String(l.discoverable) !== f.discoverable) continue;
      if (!numericMatches(f.available_count, Number(l.available_count || 0))) continue;
      if (f.has_page_view === 'has' && l.page_view_id == null) continue;
      if (f.has_page_view === 'none' && l.page_view_id != null) continue;
      if (f.linked && f.linked !== 'any') {
        if (f.linked === 'cat_removed' && !l.cat_removed) continue;
        else if (f.linked === 'model_removed' && !l.model_removed) continue;
        else if (f.linked === 'model_merged' && !l.model_merged) continue;
        else if (f.linked === 'any_flag' && !(l.cat_removed || l.model_removed || l.model_merged)) continue;
      }
      if (_state.block.enabled && _blockIdSet && !_blockIdSet.has(Number(l.id))) continue;
      if (_state.has_block === 'has' && _hasBlockIdSet && !_hasBlockIdSet.has(Number(l.id))) continue;
      if (_state.has_block === 'none' && _hasBlockIdSet && _hasBlockIdSet.has(Number(l.id))) continue;
      out.push(l);
    }
    const { col, dir } = _state.sort;
    const mult = dir === 'asc' ? 1 : -1;
    out.sort((a, b) => {
      const av = a[col]; const bv = b[col];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mult;
      return String(av ?? '').localeCompare(String(bv ?? '')) * mult;
    });
    return out;
  }

  const SORTABLE_COLS = ['id', 'slug', 'name', 'query', 'type', 'state', 'available_count'];

  function renderResults() {
    const wrap = document.getElementById('landers-results');
    if (!wrap) return;
    const rows = filterLanders();
    _lastFilteredIds = rows.map((l) => Number(l.id));
    // Drop selections that no longer match the current filter set so the count
    // and the action stay honest.
    const filteredSet = new Set(_lastFilteredIds);
    for (const id of Array.from(_selectedLanderIds)) {
      if (!filteredSet.has(id)) _selectedLanderIds.delete(id);
    }
    document.getElementById('landers-count').textContent =
      `${rows.length.toLocaleString()} match${rows.length === 1 ? '' : 'es'} of ${_allLanders.length.toLocaleString()} synced`;

    const MAX = 500;
    const truncated = rows.length > MAX;
    const display = truncated ? rows.slice(0, MAX) : rows;
    const allDisplayedSelected = display.length > 0 && display.every((l) => _selectedLanderIds.has(Number(l.id)));

    const arrow = (col) => _state.sort.col === col ? (_state.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    const th = (col, label) => `<th class="sortable" data-col="${col}">${label}${arrow(col)}</th>`;

    wrap.innerHTML = `
      ${renderActionBarHtml(rows.length)}
      ${truncated ? `<p class="muted small" style="margin:6px 0;">Showing first ${MAX.toLocaleString()} of ${rows.length.toLocaleString()} — narrow the filters to see more.</p>` : ''}
      <table class="landers-table">
        <thead>
          <tr>
            <th class="lf-check-col"><input type="checkbox" id="lf-select-all"${allDisplayedSelected ? ' checked' : ''} title="Select all matches (capped at ${LANDER_SELECTION_CAP.toLocaleString()})"></th>
            ${th('id', 'ID')}
            ${th('slug', 'Slug')}
            ${th('name', 'Name')}
            <th>Title Tag</th>
            ${th('query', 'Query')}
            ${th('type', 'Type')}
            ${th('state', 'State')}
            <th>Disc.</th>
            ${th('available_count', 'Avail.')}
            <th>PV</th>
            <th>Redirect</th>
            <th>Linked</th>
            <th>Admin</th>
          </tr>
        </thead>
        <tbody>
          ${display.map(rowHtml).join('')}
        </tbody>
      </table>
    `;

    wrap.querySelectorAll('th.sortable').forEach((th) => {
      th.addEventListener('click', () => {
        const col = th.getAttribute('data-col');
        if (!SORTABLE_COLS.includes(col)) return;
        if (_state.sort.col === col) {
          _state.sort.dir = _state.sort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          _state.sort.col = col;
          _state.sort.dir = (col === 'id' || col === 'available_count') ? 'desc' : 'asc';
        }
        persistAndRender();
      });
    });
    wrap.querySelectorAll('tr[data-lander-id]').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('a')) return; // let admin link clicks pass through
        if (e.target.closest('.lf-row-check')) return; // checkbox handles itself
        const id = Number(tr.getAttribute('data-lander-id'));
        openLanderDetail(id);
      });
    });
    wrap.querySelectorAll('.lf-row-check').forEach((cb) => {
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', (e) => {
        const id = Number(e.target.getAttribute('data-id'));
        if (e.target.checked) _selectedLanderIds.add(id);
        else _selectedLanderIds.delete(id);
        updateActionBar();
        const selAll = document.getElementById('lf-select-all');
        if (selAll) {
          selAll.checked = display.length > 0 && display.every((l) => _selectedLanderIds.has(Number(l.id)));
        }
      });
    });
    bindActionBarHandlers();
  }

  // ---- selection / bulk-action bar ----

  function renderActionBarHtml(matchCount) {
    const binding = landerBinding();
    const connected = !!(global.Sheets && Sheets.isConnected && Sheets.isConnected());
    const queued = _landerSheetMap.size;
    const sheetStatus = binding
      ? `Bound: <a href="${escapeAttr(binding.url)}" target="_blank" rel="noopener">${escapeHtml(binding.title || 'Landers sheet')} ↗</a>`
      : (connected ? 'No landers sheet yet.' : 'Connect Google in Settings to link a sheet.');
    return `
      <div class="landers-action-bar">
        <span id="lf-selected-count" class="small"><strong>${_selectedLanderIds.size.toLocaleString()}</strong> selected${matchCount > LANDER_SELECTION_CAP ? ` · select-all caps at ${LANDER_SELECTION_CAP.toLocaleString()}` : ''}</span>
        <button class="ghost small" id="lf-select-all-matches">Select all matches</button>
        <button class="ghost small" id="lf-clear-selection">Clear selection</button>
        <div class="spacer"></div>
        <span class="muted small" id="lf-sheet-status">${sheetStatus}</span>
        <button class="ghost small" id="lf-create-sheet"${connected ? '' : ' disabled'}>${binding ? 'New Landers Sheet' : 'Create Landers Sheet'}</button>
        ${binding ? '<button class="ghost small" id="lf-disconnect-sheet">Disconnect sheet</button>' : ''}
        <button class="primary small" id="lf-action"${_selectedLanderIds.size ? '' : ' disabled'}>Action…</button>
        ${queued ? `<button class="ghost small" id="lf-download-csv">Download CSV (${queued.toLocaleString()})</button>` : ''}
      </div>
    `;
  }

  function updateActionBar() {
    const count = document.getElementById('lf-selected-count');
    if (count) count.innerHTML = `<strong>${_selectedLanderIds.size.toLocaleString()}</strong> selected${_lastFilteredIds.length > LANDER_SELECTION_CAP ? ` · select-all caps at ${LANDER_SELECTION_CAP.toLocaleString()}` : ''}`;
    const action = document.getElementById('lf-action');
    if (action) action.disabled = _selectedLanderIds.size === 0;
  }

  function bindActionBarHandlers() {
    const selAll = document.getElementById('lf-select-all');
    if (selAll) selAll.addEventListener('change', (e) => selectAllMatches(e.target.checked));
    const selAllBtn = document.getElementById('lf-select-all-matches');
    if (selAllBtn) selAllBtn.addEventListener('click', () => selectAllMatches(true));
    const clearBtn = document.getElementById('lf-clear-selection');
    if (clearBtn) clearBtn.addEventListener('click', () => selectAllMatches(false));
    const createBtn = document.getElementById('lf-create-sheet');
    if (createBtn) createBtn.addEventListener('click', createLanderSheet);
    const disconnectBtn = document.getElementById('lf-disconnect-sheet');
    if (disconnectBtn) disconnectBtn.addEventListener('click', disconnectLanderSheet);
    const actionBtn = document.getElementById('lf-action');
    if (actionBtn) actionBtn.addEventListener('click', openLanderActionModal);
    const csvBtn = document.getElementById('lf-download-csv');
    if (csvBtn) csvBtn.addEventListener('click', downloadLanderCsv);
  }

  // Select (or clear) the full filtered set, capped. Re-renders so every visible
  // checkbox reflects the new state.
  function selectAllMatches(on) {
    if (!on) {
      _selectedLanderIds.clear();
    } else {
      const capped = _lastFilteredIds.slice(0, LANDER_SELECTION_CAP);
      _selectedLanderIds = new Set(capped);
      if (_lastFilteredIds.length > LANDER_SELECTION_CAP) {
        landerToast(`Capped at ${LANDER_SELECTION_CAP.toLocaleString()} of ${_lastFilteredIds.length.toLocaleString()} matches.`, '');
      }
    }
    renderResults();
  }

  async function createLanderSheet() {
    if (!global.Sheets || !Sheets.isConnected()) {
      return landerToast('Connect Google in Settings first.', 'error');
    }
    const title = `SidelineSwap Landers — ${new Date().toISOString().slice(0, 10)}`;
    const btn = document.getElementById('lf-create-sheet');
    if (btn) btn.disabled = true;
    try {
      const result = await Sheets.createSheet({
        title,
        headerRow: LANDER_BULK_IMPORT_HEADERS,
        bindingKey: LANDERS_BINDING_KEY,
      });
      landerToast(`Landers sheet created: ${result.url}`, 'ok');
    } catch (e) {
      landerToast('Create failed: ' + e.message, 'error');
    }
    renderResults();
  }

  function disconnectLanderSheet() {
    if (global.Sheets && Sheets.unbindSheet) Sheets.unbindSheet(LANDERS_BINDING_KEY);
    landerToast('Landers sheet unbound — create or link a new one. The sheet in Google is untouched.', 'ok');
    renderResults();
  }

  function closeLanderActionModal() {
    const m = document.getElementById('lander-action-modal');
    if (m) m.remove();
  }

  function openLanderActionModal() {
    if (!_selectedLanderIds.size) return;
    closeLanderActionModal();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.id = 'lander-action-modal';
    backdrop.innerHTML = `
      <div class="modal" style="max-width: 520px;">
        <h3>Bulk action on ${_selectedLanderIds.size.toLocaleString()} lander${_selectedLanderIds.size === 1 ? '' : 's'}</h3>
        <p class="muted small">Describe the change in plain English. Only <strong>state</strong> and <strong>discoverable</strong> can be set. Each lander's full template fields are fetched from the DB; your change is layered on top and highlighted yellow in the bound sheet.</p>
        <textarea id="lf-action-input" rows="3" placeholder="e.g. set these to removed" style="width:100%;"></textarea>
        <div id="lf-action-status" class="muted small" style="margin-top:6px;"></div>
        <div class="modal-actions" style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;">
          <button class="ghost" id="lf-action-cancel">Cancel</button>
          <button class="primary" id="lf-action-start">Start</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    const input = document.getElementById('lf-action-input');
    input.focus();
    document.getElementById('lf-action-cancel').addEventListener('click', closeLanderActionModal);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeLanderActionModal(); });
    document.getElementById('lf-action-start').addEventListener('click', () => {
      runLanderAction((input.value || '').trim());
    });
  }

  async function postLanderAction(instruction) {
    const res = await fetch('/api/landers/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function runLanderAction(instruction) {
    if (!instruction) { document.getElementById('lf-action-input').focus(); return; }
    const ids = Array.from(_selectedLanderIds);
    if (!ids.length) return;
    const statusEl = document.getElementById('lf-action-status');
    const startBtn = document.getElementById('lf-action-start');
    const setStatus = (msg, err) => {
      if (!statusEl) return;
      statusEl.textContent = msg;
      statusEl.style.color = err ? 'var(--red)' : '';
    };
    if (startBtn) startBtn.disabled = true;
    try {
      setStatus('Interpreting…');
      const result = await postLanderAction(instruction);
      const changes = result.changes || {};
      if (!Object.keys(changes).length) {
        setStatus(result.refusal || 'No applicable change.', true);
        if (startBtn) startBtn.disabled = false;
        return;
      }
      setStatus(`Fetching fields for ${ids.length.toLocaleString()} landers…`);
      const fieldsMap = await fetchLanderTemplateFields(ids);

      const rows = [];
      for (const id of ids) {
        const fields = fieldsMap.get(Number(id));
        if (!fields) continue;
        rows.push(buildLanderValues(fields, changes));
        await Storage.addLanderSheetEntry({ id: Number(id), fields, changes, instruction, explanation: result.explanation || '' });
      }
      await refreshLanderSheetMap();

      const binding = landerBinding();
      if (binding && rows.length) {
        try {
          setStatus(`Appending ${rows.length.toLocaleString()} rows to the sheet…`);
          const appendRes = await Sheets.appendRows(rows, LANDERS_BINDING_KEY);
          const range = appendRes && appendRes.updates && appendRes.updates.updatedRange;
          const cols = computeChangedLanderColumns(changes);
          if (range && cols.length) {
            await Sheets.highlightColumnsInRange({ range, columnIndices: cols, bindingKey: LANDERS_BINDING_KEY });
          }
          landerToast(`Applied to ${rows.length.toLocaleString()} landers and synced to the sheet.`, 'ok');
        } catch (e) {
          landerToast(`Saved locally; Sheets sync failed: ${e.message}. Use Download CSV.`, 'error');
        }
      } else {
        landerToast(`Saved ${rows.length.toLocaleString()} landers locally. No sheet bound — use Download CSV.`, '');
      }

      _selectedLanderIds.clear();
      closeLanderActionModal();
      renderResults();
    } catch (e) {
      setStatus('Failed: ' + e.message, true);
      if (startBtn) startBtn.disabled = false;
    }
  }

  async function downloadLanderCsv() {
    let entries;
    try {
      entries = await Storage.listLanderSheetEntries();
    } catch (e) {
      return landerToast('Could not read queued landers: ' + e.message, 'error');
    }
    if (!entries.length) return landerToast('No queued lander changes to export.', '');
    const data = entries.map((e) => buildLanderValues(e.fields, e.changes));
    const csv = Papa.unparse({ fields: LANDER_BULK_IMPORT_HEADERS, data });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `landers-update-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function rowHtml(l) {
    const lUrl = adminUrl('lander', l.id);
    const pvUrl = adminUrl('page_view', l.page_view_id);
    const rdUrl = adminUrl('lander', l.redirect_target_id);
    const stateTag = l.state ? `<span class="state-tag state-${escapeAttr(l.state)}">${escapeHtml(l.state)}</span>` : '';
    const discIcon = l.discoverable ? '✓' : '—';
    const checked = _selectedLanderIds.has(Number(l.id)) ? ' checked' : '';
    const queued = _landerSheetMap.get(Number(l.id));
    const changes = queued && queued.changes ? queued.changes : null;
    const stateDiff = changes && changes.state != null
      ? `<span class="lf-diff">→ <strong>${escapeHtml(changes.state)}</strong></span>` : '';
    const discDiff = changes && changes.discoverable != null
      ? `<span class="lf-diff">→ <strong>${changes.discoverable ? '✓' : '—'}</strong></span>` : '';
    return `
      <tr data-lander-id="${l.id}" class="clickable${queued ? ' lf-queued' : ''}">
        <td class="lf-check-col"><input type="checkbox" class="lf-row-check" data-id="${l.id}"${checked}></td>
        <td class="num">${l.id}</td>
        <td><code>${escapeHtml(l.slug)}</code></td>
        <td>${escapeHtml(l.name)}</td>
        <td class="muted small">${escapeHtml(l.title_tag)}</td>
        <td>${escapeHtml(l.query)}</td>
        <td>${escapeHtml(l.type)}</td>
        <td>${stateTag}${stateDiff}</td>
        <td>${discIcon}${discDiff}</td>
        <td class="num">${(l.available_count || 0).toLocaleString()}</td>
        <td>${l.page_view_id ? `<a href="${escapeAttr(pvUrl)}" target="_blank" rel="noopener">${l.page_view_id}</a>` : '—'}</td>
        <td>${l.redirect_target_id ? `<a href="${escapeAttr(rdUrl)}" target="_blank" rel="noopener">${l.redirect_target_id}</a>` : '—'}</td>
        <td>${linkedBadges(l) || '—'}</td>
        <td><a href="${escapeAttr(lUrl)}" target="_blank" rel="noopener">Open ↗</a></td>
      </tr>
    `;
  }

  function linkedBadges(l) {
    const out = [];
    if (l.cat_removed) out.push('<span class="state-tag state-removed">cat removed</span>');
    if (l.model_removed) out.push('<span class="state-tag state-removed">model removed</span>');
    if (l.model_merged) out.push('<span class="state-tag lf-merged-tag">model merged</span>');
    return out.join(' ');
  }

  async function openLanderDetail(landerId) {
    const lander = _allLanders.find((l) => Number(l.id) === Number(landerId));
    if (!lander) return;
    const drawer = document.getElementById('lander-detail');
    drawer.classList.remove('hidden');
    drawer.innerHTML = `
      <div class="lander-detail-header">
        <h3>${escapeHtml(lander.name || '(no name)')} <span class="muted small">#${lander.id}</span></h3>
        <button class="ghost" id="lander-detail-close">Close ×</button>
      </div>
      <div class="lander-detail-meta muted small">
        <code>${escapeHtml(lander.slug)}</code> · type <strong>${escapeHtml(lander.type)}</strong> · state <strong>${escapeHtml(lander.state)}</strong>
        · query "<em>${escapeHtml(lander.query)}</em>"
        ${lander.redirect_target_id ? `· redirects to <a href="${escapeAttr(adminUrl('lander', lander.redirect_target_id))}" target="_blank" rel="noopener">#${lander.redirect_target_id}</a>` : ''}
        · <a href="${escapeAttr(adminUrl('lander', lander.id))}" target="_blank" rel="noopener">Lander ↗</a>
        ${lander.page_view_id ? `· <a href="${escapeAttr(adminUrl('page_view', lander.page_view_id))}" target="_blank" rel="noopener">PageView #${lander.page_view_id} ↗</a>` : '· (no page_view)'}
        ${linkedBadges(lander) ? `· ${linkedBadges(lander)}` : ''}
      </div>
      <div id="lander-detail-blocks"><span class="muted small">Loading blocks…</span></div>
    `;
    document.getElementById('lander-detail-close').addEventListener('click', () => {
      drawer.classList.add('hidden');
      drawer.innerHTML = '';
    });
    drawer.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const blocksWrap = document.getElementById('lander-detail-blocks');
    if (!lander.page_view_id) {
      blocksWrap.innerHTML = `<p class="muted small">No page_view attached — nothing to load.</p>`;
      return;
    }
    try {
      const { blocks } = await fetchLanderDetail(lander);
      if (!blocks.length) {
        blocksWrap.innerHTML = `<p class="muted small">Page view has no blocks.</p>`;
        return;
      }
      blocksWrap.innerHTML = blocks.map(renderBlock).join('');
    } catch (e) {
      blocksWrap.innerHTML = `<p class="muted small" style="color:var(--red);">Failed to load: ${escapeHtml(e.message)}</p>`;
    }
  }

  function renderBlock(b) {
    const plats = ['web', 'ios', 'android', 'mobile']
      .filter((k) => b[k] === 1 || b[k] === true)
      .join(', ');
    const tiles = (b.tiles || []).map((t) => `
      <li class="lander-tile">
        <a href="${escapeAttr(adminUrl('tile', t.tile_id))}" target="_blank" rel="noopener">#${t.tile_id}</a>
        <strong>${escapeHtml(t.tile_title || '(untitled)')}</strong>
        ${t.tile_subtitle ? `<span class="muted small">${escapeHtml(t.tile_subtitle)}</span>` : ''}
        ${t.tile_destination ? `<code class="muted small">${escapeHtml(t.tile_destination)}</code>` : ''}
      </li>
    `).join('');
    return `
      <div class="lander-block">
        <div class="lander-block-header">
          <span class="lander-block-pos">#${b.block_position}</span>
          <a href="${escapeAttr(adminUrl('block', b.block_id))}" target="_blank" rel="noopener">Block #${b.block_id} ↗</a>
          <strong>${escapeHtml(b.block_title || b.block_name || '(untitled)')}</strong>
          <span class="muted small">${escapeHtml(b.block_layout || '')}${b.block_data_type ? ' · ' + escapeHtml(b.block_data_type) : ''}</span>
          <span class="muted small">[${plats || 'none'}]</span>
          ${b.block_active === 1 || b.block_active === true ? '' : '<span class="state-tag state-removed">inactive</span>'}
        </div>
        ${b.block_query ? `<div class="muted small">query: <code>${escapeHtml(b.block_query)}</code></div>` : ''}
        ${b.block_destination ? `<div class="muted small">destination: <code>${escapeHtml(b.block_destination)}</code></div>` : ''}
        ${tiles ? `<ul class="lander-tiles">${tiles}</ul>` : '<div class="muted small" style="margin-top:4px;">No tiles attached.</div>'}
      </div>
    `;
  }

  async function onSyncClick() {
    const btn = document.getElementById('landers-sync-btn');
    const status = document.getElementById('landers-sync-status');
    btn.disabled = true;
    try {
      await Metabase.ensureAuth();
    } catch (e) {
      status.textContent = 'Metabase auth required. Open Sync in the header to set credentials.';
      btn.disabled = false;
      return;
    }
    const states = Array.from(document.querySelectorAll('.lf-sync-state'))
      .filter((c) => c.checked).map((c) => c.value);
    if (!states.length) {
      status.textContent = 'Select at least one state to include.';
      status.style.color = 'var(--red)';
      btn.disabled = false;
      return;
    }
    saveSyncStates(states);
    try {
      const count = await syncAllLanders(states, (msg) => { status.textContent = msg; });
      status.textContent = `${count.toLocaleString()} landers (${states.join(', ')}) · synced just now.`;
      _allLanders = await Storage.listLanders();
      // Re-render to show filters + table.
      render();
    } catch (e) {
      status.textContent = 'Sync failed: ' + e.message;
      status.style.color = 'var(--red)';
    } finally {
      btn.disabled = false;
    }
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  global.LandersTool = { render };
})(window);
