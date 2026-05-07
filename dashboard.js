// dashboard.js — all UI rendering for the merch dashboard.
// Entry point: Dashboard.init() (called from index.html after the password gate).
//
// Architecture: relatable (leaf) categories are the primary unit of work --
// models attach to a leaf category like "Baseball > Bats", not to a sport.
// Sport is a filter on top of the category list.
//
// State kept in module-level variables; persisted state in IndexedDB (Storage)
// and localStorage. Re-renders are explicit (no framework reactivity).

(function (global) {
  // -------- module state --------

  let _sportsMeta = [];           // [{id, name}] -- sports that have at least one relatable category
  let _sportFilter = 'all';       // 'all' or sport id
  let _activeCategoryId = null;   // id of the relatable category currently open
  let _activeCategory = null;     // hydrated cat record while the panel is open
  let _proposalState = null;

  // Category-panel state. Reset whenever the active category changes.
  let _filters = { brand: 'all', state: 'all', search: '' };
  let _sort = { col: 'sold_count', dir: 'desc' };
  let _mode = 'browse'; // 'browse' | 'merge' | 'rename'
  let _mergeSelection = { sourceId: null, targetId: null };
  let _renameEditingId = null; // model id whose name cell is currently being edited

  const SPORT_FILTER_KEY = 'merch-sport-filter';
  const ACTIVE_CATEGORY_KEY = 'merch-active-category';
  const SPORTS_META_KEY = 'merch-sports-meta'; // cached sport id->name map

  // Bulk-import CSV / Sheets header order. Locked by engineering's importer.
  // Used by downloadCsv (CSV export) and Sheets.createSheet/appendRows
  // (live sheet sync). Same row-builder feeds both paths.
  const BULK_IMPORT_HEADERS = [
    'model_id', 'description', 'position', 'primary_image_url', 'secondary_image_url',
    'state', 'merge_target_id', 'category_id', 'name', 'brand_id', 'synonyms',
    'price_retail', 'gtin', 'mpn', 'line', 'importance', 'expert_pick',
    'value_guides_start_date', 'detail_ids',
  ];

  // -------- init --------

  async function init() {
    await Storage.openDB();
    await Storage.clearExpiredDecisions();
    bindGlobalHandlers();
    loadCachedSportsMeta();
    _sportFilter = localStorage.getItem(SPORT_FILTER_KEY) || 'all';
    _activeCategoryId = localStorage.getItem(ACTIVE_CATEGORY_KEY) || null;
    await renderSportFilter();
    await refreshSheetCount();
    await renderActive();
  }

  function bindGlobalHandlers() {
    document.querySelectorAll('[data-close]').forEach((b) => {
      b.addEventListener('click', () => closeModal(b.getAttribute('data-close')));
    });
    document.getElementById('open-sync').addEventListener('click', () => openSyncModal());
    document.getElementById('open-sheet').addEventListener('click', toggleSheet);
    document.getElementById('open-settings').addEventListener('click', openSettingsModal);
    document.getElementById('close-sheet').addEventListener('click', closeSheet);
    document.getElementById('push-to-sheets').addEventListener('click', pushSheetToGoogle);
    document.getElementById('save-mb-config').addEventListener('click', saveMetabaseConfig);
    document.getElementById('test-mb-config').addEventListener('click', testMetabaseConnection);
    document.getElementById('run-sync').addEventListener('click', runSync);
    document.getElementById('csv-upload').addEventListener('click', importFromCsv);
    document.getElementById('approve-high').addEventListener('click', () => bulkSetAction(0.85));
    document.getElementById('reject-selected').addEventListener('click', rejectSelected);
    document.getElementById('add-to-sheet').addEventListener('click', addApprovedToSheet);
    document.getElementById('clear-sheet').addEventListener('click', confirmClearSheet);
    document.getElementById('download-csv').addEventListener('click', downloadCsv);
    document.getElementById('sync-sport-filter').addEventListener('change', () => renderCategoryPicker());
    document.getElementById('connect-google').addEventListener('click', connectGoogleSheets);
    document.getElementById('disconnect-google').addEventListener('click', disconnectGoogleSheets);
    document.getElementById('create-sheet').addEventListener('click', createGoogleSheet);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        ['sync-modal', 'proposal-modal', 'convention-modal', 'confirm-modal', 'settings-modal']
          .forEach((id) => closeModal(id));
        closeSheet();
        if (_mode === 'rename' && _renameEditingId != null) cancelRenameEdit();
      }
    });
  }

  function loadCachedSportsMeta() {
    try {
      const raw = localStorage.getItem(SPORTS_META_KEY);
      _sportsMeta = raw ? JSON.parse(raw) : [];
    } catch (_) {
      _sportsMeta = [];
    }
  }
  function saveCachedSportsMeta(list) {
    _sportsMeta = list || [];
    localStorage.setItem(SPORTS_META_KEY, JSON.stringify(_sportsMeta));
  }
  function sportNameFor(sportId) {
    const m = _sportsMeta.find((s) => String(s.id) === String(sportId));
    return m ? m.name : null;
  }

  // -------- sport filter strip --------

  async function renderSportFilter() {
    const cats = await Storage.listCategories();
    // Sports we know about: cached metadata + any sport id present on a category
    // record. Build a unified list keyed by id.
    const map = new Map();
    for (const s of _sportsMeta) map.set(String(s.id), { id: String(s.id), name: s.name });
    for (const c of cats) {
      if (c.sportId && !map.has(String(c.sportId))) {
        map.set(String(c.sportId), { id: String(c.sportId), name: c.sportName || `Sport #${c.sportId}` });
      }
    }
    const sports = Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));

    const el = document.getElementById('sport-filter');
    el.innerHTML = '';
    const all = document.createElement('span');
    all.className = 'sport-pill' + (_sportFilter === 'all' ? ' active' : '');
    all.textContent = 'All sports';
    all.addEventListener('click', () => setSportFilter('all'));
    el.appendChild(all);

    for (const s of sports) {
      const p = document.createElement('span');
      p.className = 'sport-pill' + (_sportFilter === s.id ? ' active' : '');
      p.textContent = s.name;
      p.addEventListener('click', () => setSportFilter(s.id));
      el.appendChild(p);
    }

    if (!sports.length) {
      const hint = document.createElement('span');
      hint.className = 'muted small';
      hint.style.marginLeft = '8px';
      hint.textContent = 'Sports appear here once you sync a category.';
      el.appendChild(hint);
    }
  }

  async function setSportFilter(value) {
    _sportFilter = value;
    if (value === 'all') localStorage.removeItem(SPORT_FILTER_KEY);
    else localStorage.setItem(SPORT_FILTER_KEY, value);
    await renderSportFilter();
    if (!_activeCategoryId) await renderActive();
  }

  // -------- main pane --------

  function renderEmpty() {
    document.getElementById('main').innerHTML = `
      <div class="empty-state">
        <strong>No categories synced yet.</strong>
        Click <em>Sync</em> in the header to pick a relatable category — e.g. Baseball &gt; Bats — and pull its models from Metabase.
      </div>
    `;
  }

  async function renderActive() {
    if (_activeCategoryId) {
      const cat = await Storage.loadCategory(_activeCategoryId);
      if (!cat || !cat.models) {
        // The active category was deleted or never finished syncing. Bail back to the grid.
        _activeCategoryId = null;
        localStorage.removeItem(ACTIVE_CATEGORY_KEY);
        return renderActive();
      }
      renderCategoryPanel(cat);
      return;
    }
    await renderCategoryGrid();
  }

  async function renderCategoryGrid() {
    const all = await Storage.listCategories();
    const synced = all.filter((c) => c.models);
    const filtered = _sportFilter === 'all'
      ? synced
      : synced.filter((c) => String(c.sportId) === String(_sportFilter));

    const main = document.getElementById('main');
    if (!filtered.length) {
      if (synced.length === 0) {
        renderEmpty();
        return;
      }
      const sportName = sportNameFor(_sportFilter) || 'this sport';
      main.innerHTML = `
        <div class="empty-state">
          <strong>No categories synced for ${escapeHtml(sportName)} yet.</strong>
          Click <em>Sync</em> in the header to pick one.
        </div>
      `;
      return;
    }

    filtered.sort((a, b) => (a.fullName || a.name).localeCompare(b.fullName || b.name));

    const tiles = filtered.map((c) => {
      const total = c.models.length;
      const available = c.models.filter((m) => m.state === 'available').length;
      const pending = c.models.filter((m) => m.state === 'pending').length;
      const sportLabel = c.sportName || sportNameFor(c.sportId) || '';
      return `
        <div class="cat-tile" data-cat-id="${escapeAttr(c.id)}">
          <div class="cat-tile-head">
            <div class="cat-tile-title">${escapeHtml(c.fullName || c.name)}</div>
            <span class="cat-tile-resync" title="Re-sync ${escapeHtml(c.fullName || c.name)}">↻</span>
          </div>
          <div class="cat-tile-meta muted small">${escapeHtml(sportLabel)} · synced ${formatRelative(c.syncedAt)}</div>
          <div class="cat-tile-stats">
            <div><div class="num">${total.toLocaleString()}</div><div class="lbl">Models</div></div>
            <div><div class="num">${available.toLocaleString()}</div><div class="lbl">Available</div></div>
            <div><div class="num">${pending.toLocaleString()}</div><div class="lbl">Pending</div></div>
          </div>
        </div>
      `;
    }).join('');

    main.innerHTML = `
      <h2 class="page-title">Relatable categories</h2>
      <p class="page-sub">Pick a category to start finding merges, renames, or codifying naming conventions.
        Use the sport filter above to narrow the list.</p>
      <div class="cat-grid">${tiles}</div>
    `;

    main.querySelectorAll('.cat-tile').forEach((tile) => {
      const id = tile.getAttribute('data-cat-id');
      tile.addEventListener('click', (e) => {
        if (e.target.classList.contains('cat-tile-resync')) {
          e.stopPropagation();
          openSyncModal(id);
        } else {
          activateCategory(id);
        }
      });
    });
  }

  async function activateCategory(categoryId) {
    _activeCategoryId = String(categoryId);
    localStorage.setItem(ACTIVE_CATEGORY_KEY, _activeCategoryId);
    // Reset panel-local state for the new category.
    _filters = { brand: 'all', state: 'all', search: '' };
    _sort = { col: 'sold_count', dir: 'desc' };
    _mode = 'browse';
    _mergeSelection = { sourceId: null, targetId: null };
    _renameEditingId = null;
    await renderActive();
  }

  // -------- category panel: filter toolbar + model table + modes --------

  function filteredModels(cat) {
    const all = (cat && cat.models) || [];
    const q = (_filters.search || '').trim().toLowerCase();
    const out = [];
    for (const m of all) {
      if (_filters.brand !== 'all' && String(m.brand_id) !== String(_filters.brand)) continue;
      if (_filters.state !== 'all' && m.state !== _filters.state) continue;
      if (q && !(m.name || '').toLowerCase().includes(q)) continue;
      out.push(m);
    }
    const dir = _sort.dir === 'asc' ? 1 : -1;
    const col = _sort.col;
    out.sort((a, b) => {
      const av = a[col]; const bv = b[col];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
    return out;
  }

  function renderCategoryPanel(cat) {
    _activeCategory = cat;
    const main = document.getElementById('main');
    const models = cat.models || [];
    const available = models.filter((m) => m.state === 'available').length;
    const pending = models.filter((m) => m.state === 'pending').length;
    const sportLabel = cat.sportName || sportNameFor(cat.sportId) || '';
    const brands = uniqueBrands(models);

    main.innerHTML = `
      <div class="crumbs">
        <span class="crumb" id="back-to-grid">${escapeHtml(sportLabel || 'Categories')}</span>
        <span class="sep">›</span>
        <span>${escapeHtml(cat.fullName || cat.name)}</span>
      </div>
      <h2 class="page-title">${escapeHtml(cat.fullName || cat.name)}</h2>
      <p class="page-sub">${models.length.toLocaleString()} models · ${available.toLocaleString()} available · ${pending.toLocaleString()} pending · synced ${formatRelative(cat.syncedAt)}</p>

      <div class="filter-toolbar">
        <label class="filter-label">Brand
          <select id="filter-brand">
            <option value="all">All brands (${brands.length.toLocaleString()})</option>
            ${brands.map((b) => `<option value="${escapeAttr(String(b.id))}">${escapeHtml(b.name)} (${b.count.toLocaleString()})</option>`).join('')}
          </select>
        </label>
        <label class="filter-label">State
          <div class="pill-group" id="state-toggle">
            <span class="pill ${_filters.state === 'all' ? 'active' : ''}" data-state="all">All</span>
            <span class="pill ${_filters.state === 'available' ? 'active' : ''}" data-state="available">Available</span>
            <span class="pill ${_filters.state === 'pending' ? 'active' : ''}" data-state="pending">Pending</span>
          </div>
        </label>
        <label class="filter-label flex">Search
          <input type="search" id="filter-search" placeholder="model name…" value="${escapeAttr(_filters.search)}">
        </label>
      </div>

      <div class="mode-toolbar">
        <div class="pill-group" id="mode-toggle">
          <span class="pill ${_mode === 'browse' ? 'active' : ''}" data-mode="browse">Browse</span>
          <span class="pill ${_mode === 'merge' ? 'active' : ''}" data-mode="merge">Merge Mode</span>
          <span class="pill ${_mode === 'rename' ? 'active' : ''}" data-mode="rename">Rename Mode</span>
        </div>
        <div class="spacer"></div>
        <button class="ghost" id="skill-merges">Find Merges</button>
        <button class="ghost" id="skill-renames">Find Renames</button>
        <button class="ghost" id="skill-conventions">Naming Conventions</button>
      </div>

      <div class="mode-hint" id="mode-hint"></div>

      <div class="card model-table-wrap">
        <div id="model-table-host"></div>
      </div>

      <div class="merge-confirm-bar hidden" id="merge-confirm-bar"></div>
    `;

    main.querySelector('#back-to-grid').addEventListener('click', async () => {
      _activeCategoryId = null;
      _activeCategory = null;
      localStorage.removeItem(ACTIVE_CATEGORY_KEY);
      await renderActive();
    });

    main.querySelector('#filter-brand').addEventListener('change', (e) => {
      _filters.brand = e.target.value;
      renderModelTable();
    });
    main.querySelector('#state-toggle').addEventListener('click', (e) => {
      const t = e.target.closest('.pill');
      if (!t) return;
      _filters.state = t.getAttribute('data-state');
      renderCategoryPanel(_activeCategory); // re-render to update active pill class
    });
    main.querySelector('#filter-search').addEventListener('input', (e) => {
      _filters.search = e.target.value;
      renderModelTable();
    });

    main.querySelector('#mode-toggle').addEventListener('click', (e) => {
      const t = e.target.closest('.pill');
      if (!t) return;
      const next = t.getAttribute('data-mode');
      setMode(next);
    });

    main.querySelector('#skill-merges').addEventListener('click', () => runFindMerges(cat));
    main.querySelector('#skill-renames').addEventListener('click', () => runFindRenames(cat));
    main.querySelector('#skill-conventions').addEventListener('click', () => runInspectConventions(cat));

    renderModeHint();
    renderModelTable();
    renderMergeConfirmBar();
  }

  function uniqueBrands(models) {
    const m = new Map();
    for (const x of models) {
      const id = x.brand_id;
      if (id == null) continue;
      if (!m.has(id)) m.set(id, { id, name: x.brand_name || `#${id}`, count: 0 });
      m.get(id).count++;
    }
    return Array.from(m.values()).sort((a, b) => b.count - a.count);
  }

  function setMode(mode) {
    if (mode === _mode) return;
    if (_mode === 'rename' && _renameEditingId != null) cancelRenameEdit();
    _mode = mode;
    _mergeSelection = { sourceId: null, targetId: null };
    renderCategoryPanel(_activeCategory);
  }

  function renderModeHint() {
    const el = document.getElementById('mode-hint');
    if (!el) return;
    if (_mode === 'merge') {
      el.innerHTML = `<strong>Merge Mode.</strong> Click the duplicate model first (source), then the canonical model (target). Confirm at the bottom.`;
      el.className = 'mode-hint mode-merge';
    } else if (_mode === 'rename') {
      el.innerHTML = `<strong>Rename Mode.</strong> Click any model name to edit it inline. Enter to save, Esc to cancel.`;
      el.className = 'mode-hint mode-rename';
    } else {
      el.innerHTML = '';
      el.className = 'mode-hint';
    }
  }

  // -------- model table --------

  const SORTABLE_COLS = ['name', 'brand_name', 'state', 'sold_count', 'last_90_sold_count', 'available_count'];

  function renderModelTable() {
    const host = document.getElementById('model-table-host');
    if (!host) return;
    const rows = filteredModels(_activeCategory);

    if (!rows.length) {
      host.innerHTML = `<div class="empty-state" style="margin: 16px;">
        <strong>No models match.</strong> Adjust the filters above to see more.
      </div>`;
      return;
    }

    const head = (label, col) => {
      const isSorted = _sort.col === col;
      const arrow = isSorted ? (_sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
      return `<th class="sortable" data-col="${col}">${label}${arrow}</th>`;
    };

    host.innerHTML = `
      <table class="list model-table mode-${_mode}">
        <thead><tr>
          ${head('Name', 'name')}
          ${head('Brand', 'brand_name')}
          ${head('State', 'state')}
          ${head('Sold', 'sold_count')}
          ${head('Last 90', 'last_90_sold_count')}
          ${head('Avail', 'available_count')}
        </tr></thead>
        <tbody>
          ${rows.map(modelRow).join('')}
        </tbody>
      </table>
      <div class="muted small" style="padding: 8px 14px;">${rows.length.toLocaleString()} of ${(_activeCategory.models || []).length.toLocaleString()} models</div>
    `;

    host.querySelectorAll('th.sortable').forEach((th) => {
      th.addEventListener('click', () => {
        const col = th.getAttribute('data-col');
        if (!SORTABLE_COLS.includes(col)) return;
        if (_sort.col === col) _sort.dir = _sort.dir === 'asc' ? 'desc' : 'asc';
        else { _sort.col = col; _sort.dir = (col === 'name' || col === 'brand_name' || col === 'state') ? 'asc' : 'desc'; }
        renderModelTable();
      });
    });

    host.querySelectorAll('tr[data-model-id]').forEach((tr) => {
      const id = Number(tr.getAttribute('data-model-id'));
      tr.addEventListener('click', (e) => onRowClick(e, id));
    });
  }

  function modelRow(m) {
    const rowClasses = [];
    if (_mode === 'merge') {
      if (_mergeSelection.sourceId === m.id) rowClasses.push('row-source');
      else if (_mergeSelection.targetId === m.id) rowClasses.push('row-target');
    }
    const stateBadge = m.state === 'available'
      ? `<span class="tag available">Available</span>`
      : `<span class="tag pending">Pending</span>`;
    const nameCell = (_mode === 'rename' && _renameEditingId === m.id)
      ? `<input class="rename-input" data-id="${m.id}" value="${escapeAttr(m.name || '')}">`
      : `<span class="model-name${_mode === 'rename' ? ' editable' : ''}" data-id="${m.id}">${escapeHtml(m.name || '')}</span>`;
    return `
      <tr data-model-id="${m.id}" class="${rowClasses.join(' ')}">
        <td>${nameCell}<div class="muted small mono">#${m.id}</div></td>
        <td>${escapeHtml(m.brand_name || '—')}</td>
        <td>${stateBadge}</td>
        <td class="num">${(m.sold_count || 0).toLocaleString()}</td>
        <td class="num">${(m.last_90_sold_count || 0).toLocaleString()}</td>
        <td class="num">${(m.available_count || 0).toLocaleString()}</td>
      </tr>
    `;
  }

  function onRowClick(e, modelId) {
    if (_mode === 'merge') {
      handleMergeClick(modelId);
      return;
    }
    if (_mode === 'rename') {
      // Only the model-name span starts editing; clicks elsewhere on the row are ignored.
      const nameEl = e.target.closest('.model-name.editable');
      if (!nameEl) return;
      startRenameEdit(modelId);
      return;
    }
    // Browse mode: rows are passive.
  }

  // -------- Merge Mode --------

  function handleMergeClick(modelId) {
    if (_mergeSelection.sourceId == null) {
      _mergeSelection.sourceId = modelId;
    } else if (_mergeSelection.targetId == null) {
      if (modelId === _mergeSelection.sourceId) {
        // Same row clicked twice -- treat as cancel of source.
        _mergeSelection.sourceId = null;
      } else {
        _mergeSelection.targetId = modelId;
      }
    } else {
      // Both already set; new click resets to a fresh source.
      _mergeSelection = { sourceId: modelId, targetId: null };
    }
    renderModelTable();
    renderMergeConfirmBar();
  }

  function renderMergeConfirmBar() {
    const bar = document.getElementById('merge-confirm-bar');
    if (!bar) return;
    if (_mode !== 'merge' || _mergeSelection.sourceId == null) {
      bar.classList.add('hidden');
      bar.innerHTML = '';
      return;
    }
    const all = (_activeCategory && _activeCategory.models) || [];
    const source = all.find((m) => m.id === _mergeSelection.sourceId);
    const target = _mergeSelection.targetId != null ? all.find((m) => m.id === _mergeSelection.targetId) : null;
    if (!source) {
      _mergeSelection = { sourceId: null, targetId: null };
      bar.classList.add('hidden');
      return;
    }
    const ready = !!target;
    bar.classList.remove('hidden');
    bar.innerHTML = `
      <div class="merge-confirm-text">
        ${ready
          ? `Merge <strong>${escapeHtml(source.name)}</strong> <span class="muted small">#${source.id}</span> &rarr; <strong>${escapeHtml(target.name)}</strong> <span class="muted small">#${target.id}</span>`
          : `Source: <strong>${escapeHtml(source.name)}</strong> <span class="muted small">#${source.id}</span> &middot; <span class="muted">now click the target.</span>`}
      </div>
      <div class="spacer"></div>
      <button class="ghost" id="merge-reset">Reset</button>
      <button class="primary" id="merge-approve" ${ready ? '' : 'disabled'}>Approve</button>
    `;
    bar.querySelector('#merge-reset').addEventListener('click', () => {
      _mergeSelection = { sourceId: null, targetId: null };
      renderModelTable();
      renderMergeConfirmBar();
    });
    if (ready) {
      bar.querySelector('#merge-approve').addEventListener('click', () => approveManualMerge(source, target));
    }
  }

  async function approveManualMerge(source, target) {
    const cat = _activeCategory;
    const entry = {
      sourceId: source.id,
      sourceName: source.name,
      sportId: cat.sportId || null,
      sportName: cat.sportName || sportNameFor(cat.sportId) || '',
      categoryId: cat.id,
      categoryFullName: cat.fullName || cat.name,
      brandName: source.brand_name || '',
      mergeTargetId: target.id,
      mergeTargetName: target.name,
      newName: null,
      reasoning: 'Manual merge (operator)',
    };
    try {
      await Storage.addSheetEntry(entry);
      await Storage.recordDecision({
        sourceId: source.id,
        targetId: target.id,
        newName: null,
        decision: 'approved',
        reasoning: entry.reasoning,
      });
    } catch (e) {
      return toast('Failed to save: ' + e.message, 'error');
    }
    const sheetResult = await maybeAppendToSheet([entry]);
    notifySheetResult(sheetResult, 1);
    _mergeSelection = { sourceId: null, targetId: null };
    await refreshSheetCount();
    renderModelTable();
    renderMergeConfirmBar();
  }

  // -------- Rename Mode --------

  function startRenameEdit(modelId) {
    if (_renameEditingId === modelId) return;
    if (_renameEditingId != null) cancelRenameEdit();
    _renameEditingId = modelId;
    renderModelTable();
    const input = document.querySelector(`.rename-input[data-id="${modelId}"]`);
    if (!input) return;
    input.focus();
    input.select();
    let confirmed = false;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        confirmed = true;
        commitRenameEdit(modelId, input.value);
      } else if (e.key === 'Escape') {
        confirmed = true;
        cancelRenameEdit();
      }
    });
    input.addEventListener('blur', () => {
      if (confirmed) return;
      // Treat blur as commit if the value changed, cancel otherwise.
      const m = (_activeCategory.models || []).find((x) => x.id === modelId);
      const original = m ? m.name : '';
      if ((input.value || '').trim() && input.value !== original) {
        commitRenameEdit(modelId, input.value);
      } else {
        cancelRenameEdit();
      }
    });
  }

  function cancelRenameEdit() {
    _renameEditingId = null;
    renderModelTable();
  }

  async function commitRenameEdit(modelId, rawValue) {
    const value = (rawValue || '').trim();
    const m = (_activeCategory.models || []).find((x) => x.id === modelId);
    if (!m) return cancelRenameEdit();
    if (!value || value === m.name) {
      _renameEditingId = null;
      renderModelTable();
      return;
    }
    const cat = _activeCategory;
    const entry = {
      sourceId: m.id,
      sourceName: m.name,
      sportId: cat.sportId || null,
      sportName: cat.sportName || sportNameFor(cat.sportId) || '',
      categoryId: cat.id,
      categoryFullName: cat.fullName || cat.name,
      brandName: m.brand_name || '',
      mergeTargetId: null,
      mergeTargetName: null,
      newName: value,
      reasoning: 'Manual rename (operator)',
    };
    try {
      await Storage.addSheetEntry(entry);
      await Storage.recordDecision({
        sourceId: m.id,
        targetId: null,
        newName: value,
        decision: 'approved',
        reasoning: entry.reasoning,
      });
    } catch (e) {
      toast('Failed to save: ' + e.message, 'error');
      return cancelRenameEdit();
    }
    const sheetResult = await maybeAppendToSheet([entry]);
    notifySheetResult(sheetResult, 1);
    _renameEditingId = null;
    await refreshSheetCount();
    renderModelTable();
  }

  // -------- Sheets append (shared with proposal modal + manual modes) --------

  function buildCsvRowFromEntry(e) {
    const row = Object.fromEntries(BULK_IMPORT_HEADERS.map((h) => [h, '']));
    row.model_id = e.sourceId;
    // Merges supersede renames: drop the rename if both are set.
    if (e.mergeTargetId) {
      row.merge_target_id = e.mergeTargetId;
    } else if (e.newName) {
      row.name = e.newName;
    }
    return row;
  }

  function buildCsvValuesFromEntry(e) {
    const r = buildCsvRowFromEntry(e);
    return BULK_IMPORT_HEADERS.map((h) => r[h] ?? '');
  }

  // Returns { skipped: true } | { ok: true } | { error: string }
  async function maybeAppendToSheet(entries) {
    if (!global.Sheets || !Sheets.isConnected() || !Sheets.loadBinding()) {
      return { skipped: true };
    }
    if (!entries || !entries.length) return { skipped: true };
    const rows = entries.map(buildCsvValuesFromEntry);
    try {
      await Sheets.appendRows(rows);
      return { ok: true };
    } catch (e) {
      return { error: e.message };
    }
  }

  function notifySheetResult(result, count) {
    if (result.ok) toast(`Added ${count} row(s) to the bound Google Sheet.`, 'ok');
    else if (result.error) toast(`Saved locally; Sheets append failed: ${result.error}`, 'error');
  }

  // -------- skill: find merges --------

  async function runFindMerges(cat) {
    const models = filteredModels(cat);
    if (!models.length) return toast('No models match the current filters.', 'error');
    const totalCount = (cat.models || []).length;
    const filterNote = models.length === totalCount ? '' : ` (filtered: ${models.length.toLocaleString()} of ${totalCount.toLocaleString()})`;

    const grouped = Proposals.groupByBrandCategory(models);
    openProposalModal('Finding merges...', `<div style="padding:24px;text-align:center;"><span class="spinner"></span> Clustering ${models.length.toLocaleString()} models across ${grouped.length} brands${escapeHtml(filterNote)}...</div>`);

    let allProposals = [];
    let allRejections = [];
    const allFailures = [];
    try {
      for (const g of grouped) {
        const result = await Proposals.proposeMerges({
          brandName: g.brandName,
          categoryFullName: g.categoryFullName,
          models: g.models,
          onProgress: (p) => {
            updateProposalProgress(`Brand "${g.brandName}": batch ${p.done}/${p.total}`);
          },
        });
        allProposals.push(...result.proposals.map((p) => ({ ...p, brandName: g.brandName, categoryFullName: g.categoryFullName, brandId: g.brandId, categoryId: g.categoryId })));
        allRejections.push(...result.rejections);
        if (result.failedBatches && result.failedBatches.length) {
          allFailures.push({ brandName: g.brandName, count: result.failedBatches.length, sample: result.failedBatches[0].error });
        }
      }
    } catch (e) {
      closeModal('proposal-modal');
      return toast('Merge proposal failed: ' + e.message, 'error');
    }

    if (allFailures.length) {
      const total = allFailures.reduce((s, f) => s + f.count, 0);
      toast(`${total} batch(es) failed across ${allFailures.length} brand(s). First error: ${allFailures[0].sample}`, 'error');
    }

    _proposalState = {
      kind: 'merges',
      categoryId: cat.id,
      categoryFullName: cat.fullName || cat.name,
      sportId: cat.sportId,
      sportName: cat.sportName || sportNameFor(cat.sportId) || '',
      items: allProposals.map((p) => ({
        ...p,
        action: p.confidence >= 0.85 ? 'approve' : null,
      })),
      rejections: allRejections,
    };
    renderProposalTable();
  }

  // -------- skill: find renames --------

  async function runFindRenames(cat) {
    const models = filteredModels(cat);
    if (!models.length) return toast('No models match the current filters.', 'error');

    const grouped = Proposals.groupByBrandCategory(models);
    openProposalModal('Finding renames...', `<div style="padding:24px;text-align:center;"><span class="spinner"></span> Checking ${grouped.length} brands against saved conventions...</div>`);

    let allProposals = [];
    let allRejections = [];
    let missingConvention = [];
    const allFailures = [];
    try {
      for (const g of grouped) {
        const conv = await Storage.loadConvention(g.brandId, g.categoryId);
        if (!conv) {
          missingConvention.push(g.brandName);
          continue;
        }
        const result = await Proposals.proposeRenames({
          brandName: g.brandName,
          brandId: g.brandId,
          categoryFullName: g.categoryFullName,
          categoryId: g.categoryId,
          models: g.models,
          convention: conv,
          onProgress: (p) => updateProposalProgress(`Brand "${g.brandName}": batch ${p.done}/${p.total}`),
        });
        allProposals.push(...result.proposals.map((p) => ({ ...p, brandName: g.brandName, categoryFullName: g.categoryFullName, brandId: g.brandId, categoryId: g.categoryId })));
        allRejections.push(...result.rejections);
        if (result.failedBatches && result.failedBatches.length) {
          allFailures.push({ brandName: g.brandName, count: result.failedBatches.length, sample: result.failedBatches[0].error });
        }
      }
    } catch (e) {
      closeModal('proposal-modal');
      return toast('Rename proposal failed: ' + e.message, 'error');
    }

    if (allFailures.length) {
      const total = allFailures.reduce((s, f) => s + f.count, 0);
      toast(`${total} batch(es) failed across ${allFailures.length} brand(s). First error: ${allFailures[0].sample}`, 'error');
    }

    _proposalState = {
      kind: 'renames',
      categoryId: cat.id,
      categoryFullName: cat.fullName || cat.name,
      sportId: cat.sportId,
      sportName: cat.sportName || sportNameFor(cat.sportId) || '',
      items: allProposals.map((p) => ({
        ...p,
        action: p.confidence >= 0.85 ? 'approve' : null,
      })),
      rejections: allRejections,
      missingConvention,
    };
    renderProposalTable();
  }

  // -------- skill: inspect conventions --------

  async function runInspectConventions(cat) {
    const models = cat.models || [];
    const grouped = Proposals.groupByBrandCategory(models);
    openModal('convention-modal');
    const body = document.getElementById('convention-body');
    document.getElementById('convention-title').textContent = `Naming Conventions — ${cat.fullName || cat.name}`;

    body.innerHTML = `<p class="muted small">Pick a brand to infer or refresh its naming convention. Saved conventions power Find Renames.</p>` +
      grouped.map((g) => `
        <div class="convention-card" data-brand-id="${g.brandId}" data-brand-name="${escapeAttr(g.brandName)}">
          <h4>${escapeHtml(g.brandName)} <span class="muted small">(${g.models.length.toLocaleString()} models)</span></h4>
          <div class="convention-content"><span class="muted small">Loading saved convention…</span></div>
          <div style="margin-top:8px;">
            <button class="ghost btn-infer">Infer / Refresh</button>
          </div>
        </div>
      `).join('');

    for (const g of grouped) {
      const card = body.querySelector(`[data-brand-id="${g.brandId}"]`);
      const content = card.querySelector('.convention-content');
      const conv = await Storage.loadConvention(g.brandId, g.categoryId);
      content.innerHTML = renderConventionContent(conv);
      card.querySelector('.btn-infer').addEventListener('click', async () => {
        content.innerHTML = `<span class="spinner"></span> Inferring convention from gold-standard models…`;
        try {
          const inferred = await Proposals.inferConvention({
            brandName: g.brandName,
            brandId: g.brandId,
            categoryFullName: g.categoryFullName,
            categoryId: g.categoryId,
            models: g.models,
          });
          await Storage.saveConvention(inferred);
          content.innerHTML = renderConventionContent(inferred);
          toast(`Saved convention for ${g.brandName}.`, 'ok');
        } catch (e) {
          content.innerHTML = `<span style="color:var(--bad)">${escapeHtml(e.message)}</span>`;
        }
      });
    }
  }

  function renderConventionContent(conv) {
    if (!conv) return `<span class="muted small">No saved convention. Click <strong>Infer / Refresh</strong> to generate one.</span>`;
    return `
      <div><strong>Pattern:</strong> <span class="pattern">${escapeHtml(conv.pattern || '—')}</span></div>
      ${conv.examples?.length ? `<div style="margin-top:6px;"><strong>Examples:</strong> ${conv.examples.map((e) => `<span class="tag">${escapeHtml(e)}</span>`).join(' ')}</div>` : ''}
      ${conv.rules?.length ? `<div style="margin-top:6px;"><strong>Rules:</strong><ul>${conv.rules.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul></div>` : ''}
      ${conv.exceptions?.length ? `<div><strong>Exceptions:</strong><ul>${conv.exceptions.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>` : ''}
      <div class="muted small" style="margin-top:6px;">Inferred ${formatRelative(conv.inferredAt)}.</div>
    `;
  }

  // -------- proposal review modal --------

  function openProposalModal(title, body) {
    document.getElementById('proposal-title').textContent = title;
    document.getElementById('proposal-body').innerHTML = body;
    document.getElementById('proposal-stats').textContent = '';
    openModal('proposal-modal');
  }

  function updateProposalProgress(msg) {
    const body = document.getElementById('proposal-body');
    if (body && body.querySelector('.spinner')) {
      body.innerHTML = `<div style="padding:24px;text-align:center;"><span class="spinner"></span> ${escapeHtml(msg)}</div>`;
    }
  }

  function renderProposalTable() {
    if (!_proposalState) return;
    const items = _proposalState.items;
    const isMerge = _proposalState.kind === 'merges';
    document.getElementById('proposal-title').textContent = (isMerge ? 'Merge Proposals' : 'Rename Proposals') + ` — ${_proposalState.categoryFullName}`;

    if (!items.length) {
      const note = _proposalState.missingConvention?.length
        ? `<div class="empty-state" style="margin: 16px;"><strong>Nothing to propose.</strong>
            ${_proposalState.missingConvention.length} brand(s) had no saved convention and were skipped:
            ${_proposalState.missingConvention.map(escapeHtml).join(', ')}.<br>Run <em>Inspect Naming Conventions</em> first.</div>`
        : `<div class="empty-state" style="margin: 16px;"><strong>Nothing to propose.</strong> No candidates met the threshold, or all candidates were previously rejected.</div>`;
      document.getElementById('proposal-body').innerHTML = note;
      document.getElementById('proposal-stats').textContent = `${_proposalState.rejections.length} rejected by the model.`;
      return;
    }

    const headerCols = isMerge
      ? ['', 'Source', 'Target (editable)', 'Conf', 'Reasoning', 'Action']
      : ['', 'Source', 'Proposed Name (editable)', 'Conf', 'Reasoning', 'Action'];
    const rows = items.map((it, idx) => proposalRow(it, idx, isMerge)).join('');

    document.getElementById('proposal-body').innerHTML = `
      <table class="proposal-table">
        <thead><tr>${headerCols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    bindProposalRowHandlers(isMerge);
    updateProposalStats();
  }

  function proposalRow(it, idx, isMerge) {
    const conf = (it.confidence ?? 0);
    const confClass = conf >= 0.85 ? '' : conf >= 0.6 ? '' : 'low';
    const targetCell = isMerge
      ? `<div><strong>${escapeHtml(it.target_name || '')}</strong> <span class="muted small">#${it.target_id ?? ''}</span></div>
         <input class="target-edit mono" data-field="target_id" data-idx="${idx}" placeholder="target_id" value="${it.target_id ?? ''}">`
      : `<input class="target-edit" data-field="new_name" data-idx="${idx}" value="${escapeAttr(it.new_name || '')}">`;
    return `
      <tr data-idx="${idx}">
        <td><input type="checkbox" class="row-check" data-idx="${idx}"></td>
        <td>
          <div><strong>${escapeHtml(it.source_name || '')}</strong></div>
          <div class="muted small mono">#${it.source_id} · ${escapeHtml(it.brandName || '')}</div>
        </td>
        <td>${targetCell}</td>
        <td><span class="conf-bar ${confClass}"><span style="width:${Math.round(conf * 100)}%"></span></span> <span class="small mono">${conf.toFixed(2)}</span></td>
        <td class="reasoning">${escapeHtml(it.reasoning || '')}</td>
        <td>
          <span class="action-pill approve ${it.action === 'approve' ? 'active' : ''}" data-idx="${idx}" data-action="approve">Approve</span>
          <span class="action-pill reject ${it.action === 'reject' ? 'active' : ''}" data-idx="${idx}" data-action="reject">Reject</span>
        </td>
      </tr>
    `;
  }

  function bindProposalRowHandlers(isMerge) {
    document.querySelectorAll('.action-pill').forEach((p) => {
      p.addEventListener('click', () => {
        const idx = Number(p.getAttribute('data-idx'));
        const action = p.getAttribute('data-action');
        _proposalState.items[idx].action = (_proposalState.items[idx].action === action) ? null : action;
        renderProposalTable();
      });
    });
    document.querySelectorAll('input.target-edit').forEach((el) => {
      el.addEventListener('input', () => {
        const idx = Number(el.getAttribute('data-idx'));
        const field = el.getAttribute('data-field');
        const val = el.value.trim();
        if (field === 'target_id') {
          _proposalState.items[idx].target_id = val ? Number(val) : null;
        } else {
          _proposalState.items[idx][field] = val;
        }
      });
    });
  }

  function updateProposalStats() {
    const items = _proposalState?.items || [];
    const approved = items.filter((i) => i.action === 'approve').length;
    const rejected = items.filter((i) => i.action === 'reject').length;
    document.getElementById('proposal-stats').textContent = `${approved} approved · ${rejected} rejected · ${items.length} total`;
  }

  function bulkSetAction(threshold) {
    if (!_proposalState) return;
    for (const it of _proposalState.items) {
      if ((it.confidence ?? 0) >= threshold) it.action = 'approve';
    }
    renderProposalTable();
  }

  async function rejectSelected() {
    if (!_proposalState) return;
    const checks = document.querySelectorAll('.row-check:checked');
    for (const c of checks) {
      const idx = Number(c.getAttribute('data-idx'));
      _proposalState.items[idx].action = 'reject';
    }
    renderProposalTable();
  }

  async function addApprovedToSheet() {
    if (!_proposalState) return;
    const isMerge = _proposalState.kind === 'merges';
    const approved = _proposalState.items.filter((i) => i.action === 'approve');
    const rejected = _proposalState.items.filter((i) => i.action === 'reject');

    const approvedEntries = [];
    for (const it of approved) {
      const entry = {
        sourceId: it.source_id,
        sourceName: it.source_name,
        sportId: _proposalState.sportId,
        sportName: _proposalState.sportName,
        categoryId: _proposalState.categoryId,
        categoryFullName: _proposalState.categoryFullName,
        brandName: it.brandName || '',
        mergeTargetId: isMerge ? it.target_id : null,
        mergeTargetName: isMerge ? it.target_name : null,
        newName: !isMerge ? it.new_name : null,
        reasoning: it.reasoning || '',
      };
      await Storage.addSheetEntry(entry);
      await Storage.recordDecision({
        sourceId: it.source_id,
        targetId: isMerge ? it.target_id : null,
        newName: !isMerge ? it.new_name : null,
        decision: 'approved',
        reasoning: it.reasoning,
      });
      approvedEntries.push(entry);
    }
    for (const it of rejected) {
      await Storage.recordDecision({
        sourceId: it.source_id,
        targetId: isMerge ? it.target_id : null,
        newName: !isMerge ? it.new_name : null,
        decision: 'rejected',
        reasoning: it.reasoning,
      });
    }
    closeModal('proposal-modal');
    await refreshSheetCount();
    toast(`Added ${approved.length} to sheet, recorded ${rejected.length} rejections.`, 'ok');
    if (approvedEntries.length) {
      const sheetResult = await maybeAppendToSheet(approvedEntries);
      notifySheetResult(sheetResult, approvedEntries.length);
    }
  }

  // -------- sync overlay --------

  // Categories list shown in the picker. Loaded from Metabase the first time
  // credentials are configured; cached on each subsequent open until refreshed.
  let _pickerCategories = [];
  let _pickerSelectedId = null;

  async function openSyncModal(presetCategoryId) {
    const cfg = Metabase.loadConfig() || {};
    document.getElementById('mb-username').value = cfg.username || '';
    document.getElementById('mb-password').value = cfg.password || '';
    document.getElementById('mb-apikey').value = cfg.apiKey || '';
    document.getElementById('sync-progress').textContent = 'Idle.';
    document.getElementById('run-sync').disabled = true;
    _pickerSelectedId = presetCategoryId ? String(presetCategoryId) : null;
    openModal('sync-modal');

    const isConfigured = !!(cfg.apiKey || (cfg.username && cfg.password));
    const picker = document.getElementById('category-picker');
    if (!isConfigured) {
      picker.innerHTML = '<span class="muted small">Enter credentials and click <strong>Test Connection</strong> or <strong>Save Connection</strong> to load the category list.</span>';
      return;
    }
    await loadCategoriesIntoPicker();
  }

  async function loadCategoriesIntoPicker() {
    const picker = document.getElementById('category-picker');
    picker.innerHTML = '<span class="muted small">Loading categories from Metabase…</span>';
    try {
      const [sports, categories] = await Promise.all([
        Metabase.fetchSports(),
        Metabase.fetchRelatableCategories(),
      ]);
      saveCachedSportsMeta(sports.map((s) => ({ id: String(s.id), name: s.name })));

      // Enrich with sportName, persist metadata so the main UI can show
      // unsynced categories too if we ever want that. For now we just keep
      // them in memory for the picker.
      const sportNameById = new Map(sports.map((s) => [String(s.id), s.name]));
      _pickerCategories = categories.map((c) => ({
        ...c,
        sportName: sportNameById.get(String(c.sportId)) || null,
      }));

      // Populate sport filter dropdown
      const sel = document.getElementById('sync-sport-filter');
      const previous = sel.value;
      sel.innerHTML = '<option value="">All sports</option>';
      for (const s of sports) {
        const opt = document.createElement('option');
        opt.value = String(s.id);
        opt.textContent = s.name;
        sel.appendChild(opt);
      }
      if (previous) sel.value = previous;

      await renderSportFilter();
      renderCategoryPicker();
    } catch (e) {
      picker.innerHTML = `<span style="color: var(--bad);">Failed to load categories: ${escapeHtml(e.message)}</span>`;
    }
  }

  function renderCategoryPicker() {
    const picker = document.getElementById('category-picker');
    const filter = document.getElementById('sync-sport-filter').value;
    const list = filter
      ? _pickerCategories.filter((c) => String(c.sportId) === String(filter))
      : _pickerCategories;
    picker.innerHTML = '';
    if (!list.length) {
      picker.innerHTML = '<span class="muted small">No categories match this filter.</span>';
      document.getElementById('run-sync').disabled = true;
      return;
    }
    for (const c of list) {
      const btn = document.createElement('button');
      btn.className = 'ghost cat-pick';
      btn.textContent = c.fullName || c.name;
      btn.title = `#${c.id}`;
      btn.dataset.catId = c.id;
      btn.dataset.catName = c.name;
      btn.dataset.catFullName = c.fullName || c.name;
      btn.dataset.catPath = c.path;
      btn.dataset.sportId = c.sportId || '';
      btn.dataset.sportName = c.sportName || '';
      if (_pickerSelectedId && String(_pickerSelectedId) === String(c.id)) {
        btn.classList.remove('ghost');
        btn.classList.add('primary');
        document.getElementById('run-sync').disabled = false;
      }
      btn.addEventListener('click', () => {
        picker.querySelectorAll('button').forEach((b) => {
          b.classList.remove('primary'); b.classList.add('ghost');
        });
        btn.classList.remove('ghost');
        btn.classList.add('primary');
        _pickerSelectedId = c.id;
        const runBtn = document.getElementById('run-sync');
        runBtn.disabled = false;
        runBtn.dataset.catId = c.id;
        runBtn.dataset.catName = c.name;
        runBtn.dataset.catFullName = c.fullName || c.name;
        runBtn.dataset.catPath = c.path;
        runBtn.dataset.sportId = c.sportId || '';
        runBtn.dataset.sportName = c.sportName || '';
      });
      picker.appendChild(btn);
    }
    // If a preset is set, reflect it on the run-sync dataset too
    if (_pickerSelectedId) {
      const match = list.find((c) => String(c.id) === String(_pickerSelectedId));
      if (match) {
        const runBtn = document.getElementById('run-sync');
        runBtn.dataset.catId = match.id;
        runBtn.dataset.catName = match.name;
        runBtn.dataset.catFullName = match.fullName || match.name;
        runBtn.dataset.catPath = match.path;
        runBtn.dataset.sportId = match.sportId || '';
        runBtn.dataset.sportName = match.sportName || '';
      }
    }
  }

  function saveMetabaseConfig() {
    const cfg = {
      username: document.getElementById('mb-username').value.trim(),
      password: document.getElementById('mb-password').value,
      apiKey: document.getElementById('mb-apikey').value.trim() || null,
    };
    Metabase.saveConfig(cfg);
    Metabase.saveSession(null);
    toast('Metabase connection saved.', 'ok');
    loadCategoriesIntoPicker();
  }

  async function testMetabaseConnection() {
    saveMetabaseConfig();
    const log = document.getElementById('sync-progress');
    log.textContent = 'Testing connection…';
    try {
      const user = await Metabase.testConnection();
      const who = user.email || user.common_name || user.first_name || 'unknown user';
      log.textContent = `OK — connected as ${who}.`;
      toast(`Connected as ${who}.`, 'ok');
    } catch (e) {
      log.textContent = `Connection failed: ${e.message}`;
      toast('Connection failed: ' + e.message, 'error');
    }
  }

  async function runSync() {
    const btn = document.getElementById('run-sync');
    const catId = btn.dataset.catId;
    const catName = btn.dataset.catName;
    const catFullName = btn.dataset.catFullName;
    const catPath = btn.dataset.catPath;
    const sportId = btn.dataset.sportId || null;
    const sportName = btn.dataset.sportName || null;
    if (!catId) return toast('Pick a category first.', 'error');
    saveMetabaseConfig();

    const log = (msg) => {
      const el = document.getElementById('sync-progress');
      el.textContent = el.textContent + '\n' + msg;
    };
    document.getElementById('sync-progress').textContent = `Syncing ${catFullName} (#${catId})…`;
    btn.disabled = true;
    try {
      const models = await Metabase.fetchModelsForCategory(catId);
      log(`Fetched ${models.length.toLocaleString()} models.`);
      await Storage.saveCategory({
        id: String(catId),
        name: catName,
        fullName: catFullName,
        path: catPath,
        sportId: sportId ? String(sportId) : null,
        sportName: sportName || null,
        models,
        syncedAt: new Date().toISOString(),
      });
      log(`Saved to IndexedDB.`);
      await renderSportFilter();
      toast(`Synced ${catFullName}: ${models.length.toLocaleString()} models.`, 'ok');
      closeModal('sync-modal');
      await activateCategory(String(catId));
    } catch (e) {
      log(`ERROR: ${e.message}`);
      toast('Sync failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // CSV import: parse, group rows by category_id, save each group as one
  // synced category. Useful when Metabase is unreachable; columns must match
  // the MODELS_SQL projection.
  async function importFromCsv() {
    const fileEl = document.getElementById('csv-input');
    if (!fileEl.files[0]) return toast('Pick a CSV file first.', 'error');

    document.getElementById('sync-progress').textContent = 'Parsing CSV…';
    Papa.parse(fileEl.files[0], {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: async (results) => {
        const rows = (results.data || []).filter((r) => r.id && r.brand_id && r.category_id);
        if (!rows.length) return toast('CSV had no valid rows (need id, brand_id, category_id).', 'error');

        const byCategory = new Map();
        for (const r of rows) {
          const cid = String(r.category_id);
          if (!byCategory.has(cid)) byCategory.set(cid, []);
          byCategory.get(cid).push(r);
        }

        try {
          let savedCount = 0;
          for (const [cid, models] of byCategory) {
            const sample = models[0];
            const path = sample.category_path || '';
            const sportId = path ? String(path).split('/')[0] : null;
            await Storage.saveCategory({
              id: cid,
              name: sample.category_name || `#${cid}`,
              fullName: sample.category_full_name || sample.category_name || `#${cid}`,
              path,
              sportId,
              sportName: sportId ? sportNameFor(sportId) : null,
              models,
              syncedAt: new Date().toISOString(),
            });
            savedCount++;
          }
          await renderSportFilter();
          toast(`Imported ${rows.length.toLocaleString()} models across ${savedCount} categories.`, 'ok');
          closeModal('sync-modal');
          await renderActive();
        } catch (e) {
          toast('CSV save failed: ' + e.message, 'error');
        }
      },
      error: (err) => {
        toast('CSV parse failed: ' + err.message, 'error');
      },
    });
  }

  // -------- sheet panel --------

  async function toggleSheet() {
    const panel = document.getElementById('sheet-panel');
    if (panel.classList.contains('open')) closeSheet();
    else await openSheet();
  }
  async function openSheet() {
    document.getElementById('sheet-panel').classList.add('open');
    await refreshSheetPanel();
  }
  function closeSheet() {
    document.getElementById('sheet-panel').classList.remove('open');
  }

  async function pushSheetToGoogle() {
    if (!global.Sheets || !Sheets.isConnected() || !Sheets.loadBinding()) {
      return toast('Connect Google and create a sheet first (⚙ Settings).', 'error');
    }
    const entries = await Storage.listSheetEntries();
    if (!entries.length) return toast('Sheet is empty.', 'error');
    const btn = document.getElementById('push-to-sheets');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = `Pushing ${entries.length}…`;
    const result = await maybeAppendToSheet(entries);
    btn.disabled = false;
    btn.textContent = original;
    notifySheetResult(result, entries.length);
  }

  async function refreshSheetCount() {
    const entries = await Storage.listSheetEntries();
    document.getElementById('sheet-count').textContent = entries.length;
  }

  async function refreshSheetPanel() {
    const entries = await Storage.listSheetEntries();
    const body = document.getElementById('sheet-body');
    document.getElementById('sheet-count').textContent = entries.length;
    const pushBtn = document.getElementById('push-to-sheets');
    const sheetsBound = !!(global.Sheets && Sheets.isConnected() && Sheets.loadBinding());
    pushBtn.classList.toggle('hidden', !sheetsBound || !entries.length);
    if (!entries.length) {
      body.innerHTML = `<div class="empty-state" style="margin-top:18px;">
        <strong>Sheet is empty.</strong> Approve proposals to add them.
      </div>`;
      return;
    }
    const groups = new Map();
    for (const e of entries) {
      if (!groups.has(e.categoryFullName)) groups.set(e.categoryFullName, []);
      groups.get(e.categoryFullName).push(e);
    }
    body.innerHTML = '';
    for (const [cat, list] of groups) {
      const div = document.createElement('div');
      div.className = 'sheet-group';
      div.innerHTML = `<h4>${escapeHtml(cat)} <span class="muted small">(${list.length})</span></h4>`;
      for (const e of list) {
        const row = document.createElement('div');
        row.className = 'sheet-row';
        if (e.mergeTargetId) {
          row.innerHTML = `
            <div class="name"><strong>${escapeHtml(e.sourceName)}</strong> <span class="muted small">#${e.sourceId}</span><div class="muted small">→ merge into <strong>${escapeHtml(e.mergeTargetName || '')}</strong> #${e.mergeTargetId}</div></div>
            <span class="remove" data-id="${e.sourceId}" title="Remove">×</span>`;
        } else if (e.newName) {
          row.innerHTML = `
            <div class="name"><strong>${escapeHtml(e.sourceName)}</strong> <span class="muted small">#${e.sourceId}</span><div class="muted small">→ rename to <strong>${escapeHtml(e.newName)}</strong></div></div>
            <span class="remove" data-id="${e.sourceId}" title="Remove">×</span>`;
        } else {
          row.innerHTML = `
            <div class="name"><strong>${escapeHtml(e.sourceName)}</strong></div>
            <span class="remove" data-id="${e.sourceId}" title="Remove">×</span>`;
        }
        row.querySelector('.remove').addEventListener('click', async () => {
          await Storage.removeSheetEntry(e.sourceId);
          await refreshSheetPanel();
        });
        div.appendChild(row);
      }
      body.appendChild(div);
    }
  }

  function confirmClearSheet() {
    showConfirm('Clear sheet?', 'This removes all approved proposals from the in-progress sheet. Approval/rejection history in IndexedDB is preserved.', async () => {
      await Storage.clearSheet();
      await refreshSheetPanel();
      toast('Sheet cleared.', 'ok');
    });
  }

  // -------- CSV export --------

  async function downloadCsv() {
    const entries = await Storage.listSheetEntries();
    if (!entries.length) return toast('Sheet is empty.', 'error');

    const droppedRenames = entries.filter((e) => e.mergeTargetId && e.newName).length;
    const rows = entries.map(buildCsvRowFromEntry);
    if (droppedRenames > 0) {
      toast(`${droppedRenames} row(s) had both a merge and a rename — the rename was dropped (merges supersede).`, 'error');
    }

    const csv = Papa.unparse({ fields: BULK_IMPORT_HEADERS, data: rows });
    // Filename uses the dominant sport of sheet entries when available, otherwise
    // 'merch'. (Sheet entries inherit sportName from the originating category.)
    const sportTag = entries.find((e) => e.sportName)?.sportName?.toLowerCase().replace(/\s+/g, '-') || 'merch';
    const now = new Date();
    const stamp = now.toISOString().slice(0, 10) + '-' +
      [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, '0')).join('');
    const filename = `merch-update-${sportTag}-${stamp}.csv`;

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`Exported ${rows.length} row(s) to ${filename}.`, 'ok');
  }

  // -------- modal helpers --------

  function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
  function closeModal(id) { const el = document.getElementById(id); if (el) el.classList.add('hidden'); }

  function showConfirm(title, body, onOk) {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-body').textContent = body;
    const ok = document.getElementById('confirm-ok');
    const cancel = document.getElementById('confirm-cancel');
    const cleanup = () => {
      closeModal('confirm-modal');
      ok.removeEventListener('click', okHandler);
      cancel.removeEventListener('click', cancelHandler);
    };
    const okHandler = async () => { try { await onOk(); } finally { cleanup(); } };
    const cancelHandler = () => cleanup();
    ok.addEventListener('click', okHandler);
    cancel.addEventListener('click', cancelHandler);
    openModal('confirm-modal');
  }

  // -------- toasts --------

  function toast(msg, kind = '') {
    const wrap = document.getElementById('toasts');
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => { t.remove(); }, 4500);
  }

  // -------- helpers --------

  function countBy(arr, fn) {
    const m = new Map();
    for (const item of arr) {
      const k = fn(item);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return Array.from(m.entries())
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
  }

  function formatRelative(iso) {
    if (!iso) return 'never';
    const then = new Date(iso).getTime();
    const diff = Date.now() - then;
    const s = Math.round(diff / 1000);
    if (s < 60) return `${s}s ago`;
    const min = Math.round(s / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 48) return `${hr}h ago`;
    const days = Math.round(hr / 24);
    return `${days}d ago`;
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replaceAll('"', '&quot;');
  }

  // -------- Settings modal: Google Sheets connector --------

  function openSettingsModal() {
    openModal('settings-modal');
    renderSettingsBody();
  }

  function renderSettingsBody() {
    const connected = global.Sheets && Sheets.isConnected();
    const binding = global.Sheets ? Sheets.loadBinding() : null;
    document.getElementById('google-status').innerHTML = connected
      ? `<span class="tag available">Connected</span>`
      : `<span class="tag pending">Not connected</span>`;
    document.getElementById('connect-google').disabled = !!connected;
    document.getElementById('disconnect-google').disabled = !connected;
    document.getElementById('create-sheet').disabled = !connected;

    const bindingEl = document.getElementById('sheet-binding');
    if (binding) {
      bindingEl.innerHTML = `
        <div><strong>${escapeHtml(binding.title || 'Sheet')}</strong></div>
        <div class="muted small"><a href="${escapeAttr(binding.url)}" target="_blank" rel="noopener">${escapeHtml(binding.url)}</a></div>
        <div class="muted small">Created ${formatRelative(binding.createdAt)}.</div>
      `;
    } else {
      bindingEl.innerHTML = `<span class="muted small">No Sheet bound. Connect Google, then click <strong>Create Sheet</strong> to make a new bulk-import sheet.</span>`;
    }
  }

  async function connectGoogleSheets() {
    if (!global.Sheets) return toast('Sheets module unavailable.', 'error');
    try {
      await Sheets.startAuth();
      toast('Connected to Google.', 'ok');
    } catch (e) {
      toast('Connect failed: ' + e.message, 'error');
    }
    renderSettingsBody();
  }

  function disconnectGoogleSheets() {
    if (!global.Sheets) return;
    showConfirm('Disconnect Google Sheets?', 'This clears the stored Google tokens and the bound sheet id. Your Sheet itself is untouched.', () => {
      Sheets.disconnect();
      toast('Disconnected.', 'ok');
      renderSettingsBody();
    });
  }

  async function createGoogleSheet() {
    if (!global.Sheets || !Sheets.isConnected()) return toast('Connect to Google first.', 'error');
    const titleInput = document.getElementById('sheet-title');
    const title = (titleInput.value || '').trim() || `SidelineSwap Merch — ${new Date().toISOString().slice(0, 10)}`;
    try {
      const result = await Sheets.createSheet({ title, headerRow: BULK_IMPORT_HEADERS });
      toast(`Sheet created: ${result.url}`, 'ok');
    } catch (e) {
      toast('Create failed: ' + e.message, 'error');
    }
    renderSettingsBody();
    // Reveal the Push button if the sheet panel is already open and has entries.
    if (document.getElementById('sheet-panel').classList.contains('open')) {
      await refreshSheetPanel();
    }
  }

  global.Dashboard = { init };
})(window);
