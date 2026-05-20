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
    };
  }

  async function syncAllLanders(states, onProgress) {
    const sql = LANDERS_LIST_SQL_TEMPLATE.replace('__STATE_FILTER__', buildStateFilter(states));
    if (onProgress) onProgress('Querying Metabase…');
    const rows = await Metabase.runNativeQuery(sql);
    if (onProgress) onProgress(`Saving ${rows.length.toLocaleString()} landers to IndexedDB…`);
    await Storage.clearLanders();
    // Chunked writes keep individual transactions small.
    const CHUNK = 5000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK).map(normalizeLander);
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
      available_count: null, // { op, value } or null
      has_page_view: 'any',  // 'any' | 'has' | 'none'
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

  function renderFiltersHtml() {
    const f = _state.filters;
    const b = _state.block;
    return `
      <div class="landers-filters">
        <div class="landers-filter-row">
          <input type="text" id="lf-slug" placeholder="Slug contains…" value="${escapeAttr(f.slug)}">
          <input type="text" id="lf-query" placeholder="Query contains…" value="${escapeAttr(f.query)}">
          <input type="text" id="lf-name" placeholder="Name contains…" value="${escapeAttr(f.name)}">
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
    ['lf-type', 'lf-state', 'lf-discoverable'].forEach((id) => {
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
        available_count: null, has_page_view: 'any',
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
    if (f.slug_contains) parts.push(`slug contains "${f.slug_contains}"`);
    if (f.query_contains) parts.push(`query contains "${f.query_contains}"`);
    if (f.name_contains) parts.push(`name contains "${f.name_contains}"`);
    if (f.type) parts.push(`type=${f.type}`);
    if (f.state) parts.push(`state=${f.state}`);
    if (f.discoverable === true) parts.push('discoverable');
    if (f.discoverable === false) parts.push('undiscoverable');
    const ac = summarizeNumPred(f.available_count, 'available_count');
    if (ac) parts.push(ac);
    if (f.has_page_view === 'has') parts.push('has page_view');
    if (f.has_page_view === 'none') parts.push('no page_view');
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
    _state.filters.slug = f.slug_contains || '';
    _state.filters.query = f.query_contains || '';
    _state.filters.name = f.name_contains || '';
    _state.filters.type = f.type || 'all';
    _state.filters.state = f.state || 'all';
    if (f.discoverable === true) _state.filters.discoverable = '1';
    else if (f.discoverable === false) _state.filters.discoverable = '0';
    else _state.filters.discoverable = 'all';
    _state.filters.available_count = f.available_count || null;
    _state.filters.has_page_view = f.has_page_view || 'any';

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
    set('lf-type', _state.filters.type);
    set('lf-state', _state.filters.state);
    set('lf-discoverable', _state.filters.discoverable);
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

  function filterLanders() {
    const f = _state.filters;
    const slug = f.slug.trim().toLowerCase();
    const query = f.query.trim().toLowerCase();
    const name = f.name.trim().toLowerCase();
    const out = [];
    for (const l of _allLanders) {
      if (slug && !(l.slug || '').toLowerCase().includes(slug)) continue;
      if (query && !(l.query || '').toLowerCase().includes(query)) continue;
      if (name && !(l.name || '').toLowerCase().includes(name)) continue;
      if (f.type !== 'all' && l.type !== f.type) continue;
      if (f.state !== 'all' && l.state !== f.state) continue;
      if (f.discoverable !== 'all' && String(l.discoverable) !== f.discoverable) continue;
      if (!numericMatches(f.available_count, Number(l.available_count || 0))) continue;
      if (f.has_page_view === 'has' && l.page_view_id == null) continue;
      if (f.has_page_view === 'none' && l.page_view_id != null) continue;
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
    document.getElementById('landers-count').textContent =
      `${rows.length.toLocaleString()} match${rows.length === 1 ? '' : 'es'} of ${_allLanders.length.toLocaleString()} synced`;

    const MAX = 500;
    const truncated = rows.length > MAX;
    const display = truncated ? rows.slice(0, MAX) : rows;

    const arrow = (col) => _state.sort.col === col ? (_state.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    const th = (col, label) => `<th class="sortable" data-col="${col}">${label}${arrow(col)}</th>`;

    wrap.innerHTML = `
      ${truncated ? `<p class="muted small" style="margin:6px 0;">Showing first ${MAX.toLocaleString()} of ${rows.length.toLocaleString()} — narrow the filters to see more.</p>` : ''}
      <table class="landers-table">
        <thead>
          <tr>
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
        const id = Number(tr.getAttribute('data-lander-id'));
        openLanderDetail(id);
      });
    });
  }

  function rowHtml(l) {
    const lUrl = adminUrl('lander', l.id);
    const pvUrl = adminUrl('page_view', l.page_view_id);
    const rdUrl = adminUrl('lander', l.redirect_target_id);
    const stateTag = l.state ? `<span class="state-tag state-${escapeAttr(l.state)}">${escapeHtml(l.state)}</span>` : '';
    const discIcon = l.discoverable ? '✓' : '—';
    return `
      <tr data-lander-id="${l.id}" class="clickable">
        <td class="num">${l.id}</td>
        <td><code>${escapeHtml(l.slug)}</code></td>
        <td>${escapeHtml(l.name)}</td>
        <td class="muted small">${escapeHtml(l.title_tag)}</td>
        <td>${escapeHtml(l.query)}</td>
        <td>${escapeHtml(l.type)}</td>
        <td>${stateTag}</td>
        <td>${discIcon}</td>
        <td class="num">${(l.available_count || 0).toLocaleString()}</td>
        <td>${l.page_view_id ? `<a href="${escapeAttr(pvUrl)}" target="_blank" rel="noopener">${l.page_view_id}</a>` : '—'}</td>
        <td>${l.redirect_target_id ? `<a href="${escapeAttr(rdUrl)}" target="_blank" rel="noopener">${l.redirect_target_id}</a>` : '—'}</td>
        <td><a href="${escapeAttr(lUrl)}" target="_blank" rel="noopener">Open ↗</a></td>
      </tr>
    `;
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
