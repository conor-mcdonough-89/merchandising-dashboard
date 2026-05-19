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

  // ---- SQL ----

  // Light projection: omit description + synonyms (heavy fields) so the
  // ~180k row sync stays IndexedDB-friendly. Detail drawer pulls those on
  // demand if needed.
  const LANDERS_LIST_SQL = `
SELECT
  l.id,
  l.slug,
  l.name,
  l.title_tag,
  l.query,
  l.type,
  l.state,
  l.discoverable,
  l.page_view_id,
  l.redirect_target_id,
  l.canonical_id,
  l.models_category_id,
  l.show_categories,
  l.show_categories_no_images
FROM rails.landers AS l
`.trim();

  // Predicate is substituted server-side from a whitelisted column + operator
  // (see buildBlockPredicate). r.web = 1 because the user said the "web"
  // connections are the ones that matter.
  const LANDER_IDS_WITH_BLOCK_SQL_TEMPLATE = `
SELECT DISTINCT l.id
FROM rails.landers AS l
JOIN rails.page_view_block_relations AS r ON r.page_view_id = l.page_view_id
JOIN rails.page_view_blocks AS b ON b.id = r.block_id
WHERE r.web = 1
  AND __BLOCK_PREDICATE__
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
      page_view_id: r.page_view_id == null ? null : Number(r.page_view_id),
      redirect_target_id: r.redirect_target_id == null ? null : Number(r.redirect_target_id),
      canonical_id: r.canonical_id == null ? null : Number(r.canonical_id),
      models_category_id: r.models_category_id == null ? null : Number(r.models_category_id),
      show_categories: r.show_categories === 1 || r.show_categories === true ? 1 : 0,
      show_categories_no_images: r.show_categories_no_images === 1 || r.show_categories_no_images === true ? 1 : 0,
    };
  }

  async function syncAllLanders(onProgress) {
    if (onProgress) onProgress('Querying Metabase…');
    const rows = await Metabase.runNativeQuery(LANDERS_LIST_SQL);
    if (onProgress) onProgress(`Saving ${rows.length.toLocaleString()} landers to IndexedDB…`);
    await Storage.clearLanders();
    // Chunked writes keep individual transactions small.
    const CHUNK = 5000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK).map(normalizeLander);
      await Storage.putLanders(slice);
      if (onProgress) onProgress(`Saved ${Math.min(i + CHUNK, rows.length).toLocaleString()} / ${rows.length.toLocaleString()}…`);
    }
    await Storage.saveLandersMeta({ syncedAt: new Date().toISOString(), count: rows.length });
    return rows.length;
  }

  async function fetchLanderIdsWithBlock(filter) {
    const predicate = buildBlockPredicate(filter);
    const sql = LANDER_IDS_WITH_BLOCK_SQL_TEMPLATE.replace('__BLOCK_PREDICATE__', predicate);
    const rows = await Metabase.runNativeQuery(sql);
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
    filters: { slug: '', query: '', name: '', type: 'all', state: 'all', discoverable: 'all' },
    block: { enabled: false, column: 'layout', op: 'equals', value: '' },
    sort: { col: 'id', dir: 'desc' },
  };

  // Set of lander ids restricted by the last-applied block-composition filter.
  // `null` = filter disabled (no restriction). Lives outside _state because it
  // is server-derived and not worth persisting across reloads.
  let _blockIdSet = null;
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
          <span class="muted small" id="landers-sync-status">
            ${meta ? `${_allLanders.length.toLocaleString()} landers · synced ${formatRelative(meta.syncedAt)}` : 'No landers synced yet.'}
          </span>
        </div>

        ${_allLanders.length ? renderFiltersHtml() : ''}
        <div id="landers-results"></div>
        <div id="lander-detail" class="lander-detail hidden"></div>
      </div>
    `;

    document.getElementById('landers-sync-btn').addEventListener('click', onSyncClick);
    if (_allLanders.length) {
      bindFilterHandlers();
      renderResults();
    }
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
            <option value="available"${f.state === 'available' ? ' selected' : ''}>available</option>
            <option value="redirected"${f.state === 'redirected' ? ' selected' : ''}>redirected</option>
            <option value="removed"${f.state === 'removed' ? ' selected' : ''}>removed</option>
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
      _state.filters = { slug: '', query: '', name: '', type: 'all', state: 'all', discoverable: 'all' };
      _state.block = { enabled: false, column: 'layout', op: 'equals', value: '' };
      _blockIdSet = null;
      saveState(_state);
      render();
    });
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
      if (_state.block.enabled && _blockIdSet && !_blockIdSet.has(Number(l.id))) continue;
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

  const SORTABLE_COLS = ['id', 'slug', 'name', 'query', 'type', 'state'];

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
            ${th('query', 'Query')}
            ${th('type', 'Type')}
            ${th('state', 'State')}
            <th>Disc.</th>
            <th>PV</th>
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
          _state.sort.dir = (col === 'id') ? 'desc' : 'asc';
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
    const stateTag = l.state ? `<span class="state-tag state-${escapeAttr(l.state)}">${escapeHtml(l.state)}</span>` : '';
    const discIcon = l.discoverable ? '✓' : '—';
    return `
      <tr data-lander-id="${l.id}" class="clickable">
        <td class="num">${l.id}</td>
        <td><code>${escapeHtml(l.slug)}</code></td>
        <td>${escapeHtml(l.name)}</td>
        <td>${escapeHtml(l.query)}</td>
        <td>${escapeHtml(l.type)}</td>
        <td>${stateTag}</td>
        <td>${discIcon}</td>
        <td>${l.page_view_id ? `<a href="${escapeAttr(pvUrl)}" target="_blank" rel="noopener">${l.page_view_id}</a>` : '—'}</td>
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
    try {
      const count = await syncAllLanders((msg) => { status.textContent = msg; });
      status.textContent = `${count.toLocaleString()} landers · synced just now.`;
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
