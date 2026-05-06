// dashboard.js — all UI rendering for the merch dashboard.
// Entry point: Dashboard.init() (called from index.html after the password gate).
//
// State kept in module-level variables; persisted state in IndexedDB (Storage)
// and localStorage. Re-renders are explicit (no framework reactivity).

(function (global) {
  // -------- module state --------

  let _sportsList = [];      // [{id, name, path}]
  let _activeSportId = null; // sport currently displayed
  let _activeCategoryId = null;
  let _activeCategoryName = null;
  let _proposalState = null; // { kind, brandName, categoryId, items: [...] }

  const ACTIVE_SPORT_KEY = 'merch-active-sport';
  const ACTIVE_CATEGORY_KEY = 'merch-active-category';

  // -------- init --------

  async function init() {
    await Storage.openDB();
    await Storage.clearExpiredDecisions();
    bindGlobalHandlers();
    await refreshSportTabs();
    await refreshSheetCount();
    const savedSport = localStorage.getItem(ACTIVE_SPORT_KEY);
    const savedCategory = localStorage.getItem(ACTIVE_CATEGORY_KEY);
    if (savedSport) {
      _activeSportId = savedSport;
      if (savedCategory) {
        const parsed = JSON.parse(savedCategory);
        _activeCategoryId = parsed.id;
        _activeCategoryName = parsed.name;
      }
      await renderActive();
    } else {
      renderEmpty();
    }
  }

  function bindGlobalHandlers() {
    document.querySelectorAll('[data-close]').forEach((b) => {
      b.addEventListener('click', () => closeModal(b.getAttribute('data-close')));
    });
    document.getElementById('open-sync').addEventListener('click', openSyncModal);
    document.getElementById('open-sheet').addEventListener('click', openSheet);
    document.getElementById('close-sheet').addEventListener('click', closeSheet);
    document.getElementById('save-mb-config').addEventListener('click', saveMetabaseConfig);
    document.getElementById('test-mb-config').addEventListener('click', testMetabaseConnection);
    document.getElementById('run-sync').addEventListener('click', runSync);
    document.getElementById('csv-upload').addEventListener('click', importFromCsv);
    document.getElementById('approve-high').addEventListener('click', () => bulkSetAction(0.85));
    document.getElementById('reject-selected').addEventListener('click', rejectSelected);
    document.getElementById('add-to-sheet').addEventListener('click', addApprovedToSheet);
    document.getElementById('clear-sheet').addEventListener('click', confirmClearSheet);
    document.getElementById('download-csv').addEventListener('click', downloadCsv);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        ['sync-modal', 'proposal-modal', 'convention-modal', 'confirm-modal']
          .forEach((id) => closeModal(id));
        closeSheet();
      }
    });
  }

  // -------- sport tabs --------

  async function refreshSportTabs() {
    const synced = await Storage.listSports();
    _sportsList = synced.map((s) => ({ id: s.id, name: s.name, count: (s.models || []).length, syncedAt: s.syncedAt }));
    const tabsEl = document.getElementById('sport-tabs');
    tabsEl.innerHTML = '';
    if (!synced.length) {
      const empty = document.createElement('span');
      empty.className = 'sport-tab empty';
      empty.textContent = 'No sports synced yet';
      tabsEl.appendChild(empty);
    }
    for (const s of _sportsList) {
      const tab = document.createElement('div');
      tab.className = 'sport-tab' + (s.id === _activeSportId ? ' active' : '');
      tab.innerHTML = `<span>${escapeHtml(s.name)}</span> <span class="muted small">${s.count.toLocaleString()}</span> <span class="resync" title="Re-sync ${escapeHtml(s.name)}">↻</span>`;
      tab.addEventListener('click', (e) => {
        if (e.target.classList.contains('resync')) {
          e.stopPropagation();
          openSyncModal(s.id);
        } else {
          activateSport(s.id);
        }
      });
      tabsEl.appendChild(tab);
    }
    const addBtn = document.createElement('div');
    addBtn.className = 'sport-tab add';
    addBtn.textContent = '+ Sync sport';
    addBtn.addEventListener('click', () => openSyncModal());
    tabsEl.appendChild(addBtn);
  }

  async function activateSport(sportId) {
    _activeSportId = sportId;
    _activeCategoryId = null;
    _activeCategoryName = null;
    localStorage.setItem(ACTIVE_SPORT_KEY, sportId);
    localStorage.removeItem(ACTIVE_CATEGORY_KEY);
    await refreshSportTabs();
    await renderActive();
  }

  // -------- main pane --------

  function renderEmpty() {
    document.getElementById('main').innerHTML = `
      <div class="empty-state">
        <strong>No sport selected.</strong>
        Click <em>Sync</em> in the header to pull a sport from Metabase, then pick it from the tab strip above.
      </div>
    `;
  }

  async function renderActive() {
    if (!_activeSportId) return renderEmpty();
    const sport = await Storage.loadSport(_activeSportId);
    if (!sport) return renderEmpty();
    if (_activeCategoryId) {
      renderCategoryPanel(sport);
    } else {
      renderSportOverview(sport);
    }
  }

  function renderSportOverview(sport) {
    const main = document.getElementById('main');
    const models = sport.models || [];
    const available = models.filter((m) => m.state === 'available').length;
    const pending = models.filter((m) => m.state === 'pending').length;

    const brandCounts = countBy(models, (m) => m.brand_name || '(unknown)');
    const categoryCounts = countByCategory(models);

    main.innerHTML = `
      <div class="crumbs">
        <span class="crumb">${escapeHtml(sport.name)}</span>
      </div>
      <h2 class="page-title">${escapeHtml(sport.name)} overview</h2>
      <p class="page-sub">Last synced ${formatRelative(sport.syncedAt)}.
        Pick a category below to start finding merges, renames, or codifying naming conventions.</p>

      <div class="panel-grid">
        <div class="stat"><div class="label">Total Models</div><div class="value">${models.length.toLocaleString()}</div></div>
        <div class="stat"><div class="label">Available</div><div class="value">${available.toLocaleString()}</div><div class="meta">customer-visible</div></div>
        <div class="stat"><div class="label">Pending</div><div class="value">${pending.toLocaleString()}</div><div class="meta">UGC backlog</div></div>
        <div class="stat"><div class="label">Brands</div><div class="value">${brandCounts.length.toLocaleString()}</div></div>
      </div>

      <div class="two-col">
        <div class="card">
          <h3>Top Brands <span class="muted small">by model count</span></h3>
          <table class="list">
            <thead><tr><th>Brand</th><th class="num">Models</th></tr></thead>
            <tbody>
              ${brandCounts.slice(0, 10).map((b) => `
                <tr><td>${escapeHtml(b.key)}</td><td class="num">${b.count.toLocaleString()}</td></tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="card">
          <h3>Top Categories <span class="muted small">drill in to clean up</span></h3>
          <table class="list">
            <thead><tr><th>Category</th><th class="num">Models</th></tr></thead>
            <tbody>
              ${categoryCounts.slice(0, 10).map((c) => `
                <tr>
                  <td><span class="clickable" data-cat-id="${c.id}" data-cat-name="${escapeAttr(c.fullName)}">${escapeHtml(c.fullName)}</span></td>
                  <td class="num">${c.count.toLocaleString()}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
    main.querySelectorAll('[data-cat-id]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = Number(el.getAttribute('data-cat-id'));
        const name = el.getAttribute('data-cat-name');
        activateCategory(id, name);
      });
    });
  }

  async function activateCategory(categoryId, fullName) {
    _activeCategoryId = categoryId;
    _activeCategoryName = fullName;
    localStorage.setItem(ACTIVE_CATEGORY_KEY, JSON.stringify({ id: categoryId, name: fullName }));
    await renderActive();
  }

  function renderCategoryPanel(sport) {
    const main = document.getElementById('main');
    const models = (sport.models || []).filter((m) => m.category_id === _activeCategoryId);
    const available = models.filter((m) => m.state === 'available').length;
    const pending = models.filter((m) => m.state === 'pending').length;

    main.innerHTML = `
      <div class="crumbs">
        <span class="crumb" id="back-to-sport">${escapeHtml(sport.name)}</span>
        <span class="sep">›</span>
        <span>${escapeHtml(_activeCategoryName || '')}</span>
      </div>
      <h2 class="page-title">${escapeHtml(_activeCategoryName || '')}</h2>
      <p class="page-sub">${models.length.toLocaleString()} models · ${available.toLocaleString()} available · ${pending.toLocaleString()} pending</p>

      <div class="toggle-row">
        <span>Working on:</span>
        <div class="pill-group" id="state-toggle">
          <span class="pill active" data-state="available">Available</span>
          <span class="pill" data-state="pending">Pending</span>
        </div>
      </div>

      <div class="skill-row">
        <button class="skill-btn" id="skill-merges">
          <div class="title">Find Merges</div>
          <div class="desc">Cluster duplicates and propose which existing model each one folds into.</div>
        </button>
        <button class="skill-btn" id="skill-renames">
          <div class="title">Find Renames</div>
          <div class="desc">Propose canonical names for models that violate the brand's naming convention.</div>
        </button>
        <button class="skill-btn" id="skill-conventions">
          <div class="title">Inspect Naming Conventions</div>
          <div class="desc">Codify the naming pattern across this category's brands. Powers Find Renames.</div>
        </button>
      </div>

      <div class="card">
        <h3>Brands in this category <span class="muted small">${countBy(models, (m) => m.brand_name || '(unknown)').length} total</span></h3>
        <table class="list">
          <thead><tr><th>Brand</th><th class="num">Available</th><th class="num">Pending</th><th class="num">Total</th></tr></thead>
          <tbody>
            ${brandRowsForCategory(models)}
          </tbody>
        </table>
      </div>
    `;

    main.querySelector('#back-to-sport').addEventListener('click', async () => {
      _activeCategoryId = null;
      _activeCategoryName = null;
      localStorage.removeItem(ACTIVE_CATEGORY_KEY);
      await renderActive();
    });

    const stateToggle = main.querySelector('#state-toggle');
    stateToggle.addEventListener('click', (e) => {
      const t = e.target.closest('.pill');
      if (!t) return;
      stateToggle.querySelectorAll('.pill').forEach((p) => p.classList.toggle('active', p === t));
    });

    main.querySelector('#skill-merges').addEventListener('click', () => runFindMerges(sport));
    main.querySelector('#skill-renames').addEventListener('click', () => runFindRenames(sport));
    main.querySelector('#skill-conventions').addEventListener('click', () => runInspectConventions(sport));
  }

  function brandRowsForCategory(models) {
    const byBrand = new Map();
    for (const m of models) {
      const k = m.brand_name || '(unknown)';
      if (!byBrand.has(k)) byBrand.set(k, { name: k, brand_id: m.brand_id, available: 0, pending: 0 });
      const v = byBrand.get(k);
      if (m.state === 'available') v.available++;
      else if (m.state === 'pending') v.pending++;
    }
    return Array.from(byBrand.values())
      .sort((a, b) => (b.available + b.pending) - (a.available + a.pending))
      .slice(0, 25)
      .map((b) => `
        <tr>
          <td>${escapeHtml(b.name)}</td>
          <td class="num">${b.available.toLocaleString()}</td>
          <td class="num">${b.pending.toLocaleString()}</td>
          <td class="num">${(b.available + b.pending).toLocaleString()}</td>
        </tr>
      `).join('');
  }

  function activeStateFilter() {
    const active = document.querySelector('#state-toggle .pill.active');
    return active ? active.getAttribute('data-state') : 'available';
  }

  // -------- skill: find merges --------

  async function runFindMerges(sport) {
    const stateFilter = activeStateFilter();
    const models = (sport.models || []).filter((m) => m.category_id === _activeCategoryId);
    if (!models.length) return toast('No models in this category.', 'error');

    // Group by brand and run per-brand to keep clusters tight.
    const grouped = Proposals.groupByBrandCategory(models);
    openProposalModal('Finding merges...', `<div style="padding:24px;text-align:center;"><span class="spinner"></span> Clustering ${models.length.toLocaleString()} models across ${grouped.length} brands...</div>`);

    let allProposals = [];
    let allRejections = [];
    let totalBatches = 0;
    try {
      for (const g of grouped) {
        const filtered = g.models.filter((m) => m.state === stateFilter || m.state === 'available');
        const result = await Proposals.proposeMerges({
          brandName: g.brandName,
          categoryFullName: g.categoryFullName,
          models: filtered,
          onProgress: (p) => {
            updateProposalProgress(`Brand "${g.brandName}": batch ${p.done}/${p.total}`);
          },
        });
        allProposals.push(...result.proposals.map((p) => ({ ...p, brandName: g.brandName, categoryFullName: g.categoryFullName, brandId: g.brandId, categoryId: g.categoryId })));
        allRejections.push(...result.rejections);
        totalBatches += result.batches;
      }
    } catch (e) {
      closeModal('proposal-modal');
      return toast('Merge proposal failed: ' + e.message, 'error');
    }

    _proposalState = {
      kind: 'merges',
      sportId: _activeSportId,
      sportName: sport.name,
      categoryId: _activeCategoryId,
      categoryFullName: _activeCategoryName,
      items: allProposals.map((p) => ({
        ...p,
        action: p.confidence >= 0.85 ? 'approve' : null,
      })),
      rejections: allRejections,
    };
    renderProposalTable();
  }

  // -------- skill: find renames --------

  async function runFindRenames(sport) {
    const stateFilter = activeStateFilter();
    const models = (sport.models || []).filter((m) => m.category_id === _activeCategoryId);
    if (!models.length) return toast('No models in this category.', 'error');

    const grouped = Proposals.groupByBrandCategory(models);
    openProposalModal('Finding renames...', `<div style="padding:24px;text-align:center;"><span class="spinner"></span> Checking ${grouped.length} brands against saved conventions...</div>`);

    let allProposals = [];
    let allRejections = [];
    let missingConvention = [];
    try {
      for (const g of grouped) {
        const conv = await Storage.loadConvention(g.brandId, g.categoryId);
        if (!conv) {
          missingConvention.push(g.brandName);
          continue;
        }
        const filtered = g.models.filter((m) => m.state === stateFilter);
        const result = await Proposals.proposeRenames({
          brandName: g.brandName,
          brandId: g.brandId,
          categoryFullName: g.categoryFullName,
          categoryId: g.categoryId,
          models: filtered,
          convention: conv,
          onProgress: (p) => updateProposalProgress(`Brand "${g.brandName}": batch ${p.done}/${p.total}`),
        });
        allProposals.push(...result.proposals.map((p) => ({ ...p, brandName: g.brandName, categoryFullName: g.categoryFullName, brandId: g.brandId, categoryId: g.categoryId })));
        allRejections.push(...result.rejections);
      }
    } catch (e) {
      closeModal('proposal-modal');
      return toast('Rename proposal failed: ' + e.message, 'error');
    }

    _proposalState = {
      kind: 'renames',
      sportId: _activeSportId,
      sportName: sport.name,
      categoryId: _activeCategoryId,
      categoryFullName: _activeCategoryName,
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

  async function runInspectConventions(sport) {
    const models = (sport.models || []).filter((m) => m.category_id === _activeCategoryId);
    const grouped = Proposals.groupByBrandCategory(models);
    openModal('convention-modal');
    const body = document.getElementById('convention-body');
    document.getElementById('convention-title').textContent = `Naming Conventions — ${_activeCategoryName}`;

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

    // Hydrate saved conventions
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

    for (const it of approved) {
      await Storage.addSheetEntry({
        sourceId: it.source_id,
        sourceName: it.source_name,
        sportId: _proposalState.sportId,
        sportName: _proposalState.sportName,
        categoryFullName: _proposalState.categoryFullName,
        brandName: it.brandName || '',
        mergeTargetId: isMerge ? it.target_id : null,
        mergeTargetName: isMerge ? it.target_name : null,
        newName: !isMerge ? it.new_name : null,
        reasoning: it.reasoning || '',
      });
      await Storage.recordDecision({
        sourceId: it.source_id,
        targetId: isMerge ? it.target_id : null,
        newName: !isMerge ? it.new_name : null,
        decision: 'approved',
        reasoning: it.reasoning,
      });
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
  }

  // -------- sync overlay --------

  async function openSyncModal(presetSportId) {
    const cfg = Metabase.loadConfig() || {};
    document.getElementById('mb-username').value = cfg.username || '';
    document.getElementById('mb-password').value = cfg.password || '';
    document.getElementById('mb-apikey').value = cfg.apiKey || '';
    document.getElementById('sync-progress').textContent = 'Idle.';
    openModal('sync-modal');

    const picker = document.getElementById('sport-picker');
    document.getElementById('run-sync').disabled = true;
    const isConfigured = !!(cfg.apiKey || (cfg.username && cfg.password));
    if (!isConfigured) {
      picker.innerHTML = '<span class="muted small">Enter credentials and click <strong>Test Connection</strong> or <strong>Save Connection</strong> to load the sports list.</span>';
      return;
    }
    await loadSportsIntoPicker(presetSportId);
  }

  async function loadSportsIntoPicker(presetSportId) {
    const picker = document.getElementById('sport-picker');
    picker.innerHTML = '<span class="muted small">Loading sports from Metabase…</span>';
    try {
      const sports = await Metabase.fetchSports();
      picker.innerHTML = '';
      const csvSelect = document.getElementById('csv-sport');
      csvSelect.innerHTML = '<option value="">— select —</option>';
      for (const s of sports) {
        const btn = document.createElement('button');
        btn.className = 'ghost';
        btn.textContent = `${s.name} (#${s.id})`;
        btn.dataset.sportId = s.id;
        btn.dataset.sportName = s.name;
        btn.addEventListener('click', () => {
          picker.querySelectorAll('button').forEach((b) => b.classList.remove('primary'));
          picker.querySelectorAll('button').forEach((b) => b.classList.add('ghost'));
          btn.classList.remove('ghost');
          btn.classList.add('primary');
          document.getElementById('run-sync').disabled = false;
          document.getElementById('run-sync').dataset.sportId = s.id;
          document.getElementById('run-sync').dataset.sportName = s.name;
          document.getElementById('run-sync').dataset.sportPath = s.path;
        });
        picker.appendChild(btn);

        const opt = document.createElement('option');
        opt.value = JSON.stringify({ id: s.id, name: s.name, path: s.path });
        opt.textContent = s.name;
        csvSelect.appendChild(opt);

        if (presetSportId && String(s.id) === String(presetSportId)) btn.click();
      }
    } catch (e) {
      picker.innerHTML = `<span style="color: var(--bad);">Failed to load sports: ${escapeHtml(e.message)}</span>`;
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
    // Now that credentials exist, populate the sport picker.
    loadSportsIntoPicker();
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
    const sportId = btn.dataset.sportId;
    const sportName = btn.dataset.sportName;
    const sportPath = btn.dataset.sportPath;
    if (!sportId) return toast('Pick a sport first.', 'error');
    saveMetabaseConfig();

    const log = (msg) => {
      const el = document.getElementById('sync-progress');
      el.textContent = el.textContent + '\n' + msg;
    };
    document.getElementById('sync-progress').textContent = `Syncing ${sportName} (#${sportId})…`;
    btn.disabled = true;
    try {
      const models = await Metabase.fetchModelsForSport(sportId);
      log(`Fetched ${models.length.toLocaleString()} models.`);
      await Storage.saveSport({
        id: String(sportId),
        name: sportName,
        path: sportPath,
        models,
        syncedAt: new Date().toISOString(),
      });
      log(`Saved to IndexedDB.`);
      await refreshSportTabs();
      toast(`Synced ${sportName}: ${models.length.toLocaleString()} models.`, 'ok');
      closeModal('sync-modal');
      await activateSport(String(sportId));
    } catch (e) {
      log(`ERROR: ${e.message}`);
      toast('Sync failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function importFromCsv() {
    const fileEl = document.getElementById('csv-input');
    const sportEl = document.getElementById('csv-sport');
    if (!fileEl.files[0]) return toast('Pick a CSV file first.', 'error');
    if (!sportEl.value) return toast('Choose a sport for the CSV.', 'error');
    const sport = JSON.parse(sportEl.value);

    document.getElementById('sync-progress').textContent = 'Parsing CSV…';
    Papa.parse(fileEl.files[0], {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: async (results) => {
        const models = (results.data || []).filter((r) => r.id && r.brand_id && r.category_id);
        try {
          await Storage.saveSport({
            id: String(sport.id),
            name: sport.name,
            path: sport.path,
            models,
            syncedAt: new Date().toISOString(),
          });
          await refreshSportTabs();
          toast(`Imported ${models.length.toLocaleString()} models from CSV.`, 'ok');
          closeModal('sync-modal');
          await activateSport(String(sport.id));
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

  async function openSheet() {
    document.getElementById('sheet-panel').classList.add('open');
    await refreshSheetPanel();
  }
  function closeSheet() {
    document.getElementById('sheet-panel').classList.remove('open');
  }

  async function refreshSheetCount() {
    const entries = await Storage.listSheetEntries();
    document.getElementById('sheet-count').textContent = entries.length;
  }

  async function refreshSheetPanel() {
    const entries = await Storage.listSheetEntries();
    const body = document.getElementById('sheet-body');
    document.getElementById('sheet-count').textContent = entries.length;
    if (!entries.length) {
      body.innerHTML = `<div class="empty-state" style="margin-top:18px;">
        <strong>Sheet is empty.</strong> Approve proposals to add them.
      </div>`;
      return;
    }
    // Group by category
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

    const headers = [
      'model_id', 'description', 'position', 'primary_image_url', 'secondary_image_url',
      'state', 'merge_target_id', 'category_id', 'name', 'brand_id', 'synonyms',
      'price_retail', 'gtin', 'mpn', 'line', 'importance', 'expert_pick',
      'value_guides_start_date', 'detail_ids',
    ];

    const rows = [];
    let droppedRenames = 0;
    for (const e of entries) {
      const row = Object.fromEntries(headers.map((h) => [h, '']));
      row.model_id = e.sourceId;
      // Merges supersede renames: if both are set, keep the merge and warn.
      if (e.mergeTargetId && e.newName) {
        droppedRenames++;
        row.merge_target_id = e.mergeTargetId;
      } else if (e.mergeTargetId) {
        row.merge_target_id = e.mergeTargetId;
      } else if (e.newName) {
        row.name = e.newName;
      }
      rows.push(row);
    }
    if (droppedRenames > 0) {
      toast(`${droppedRenames} row(s) had both a merge and a rename — the rename was dropped (merges supersede).`, 'error');
    }

    const csv = Papa.unparse({ fields: headers, data: rows });
    const sportName = (entries[0] && entries[0].sportName) ? entries[0].sportName.toLowerCase().replace(/\s+/g, '-') : 'merch';
    const now = new Date();
    const stamp = now.toISOString().slice(0, 10) + '-' +
      [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, '0')).join('');
    const filename = `merch-update-${sportName}-${stamp}.csv`;

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

  function countByCategory(models) {
    const m = new Map();
    for (const item of models) {
      const id = item.category_id;
      if (id == null) continue;
      if (!m.has(id)) m.set(id, { id, fullName: item.category_full_name || item.category_name || `#${id}`, count: 0 });
      m.get(id).count++;
    }
    return Array.from(m.values()).sort((a, b) => b.count - a.count);
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

  global.Dashboard = { init };
})(window);
