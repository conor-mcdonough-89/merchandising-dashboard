// storage.js — IndexedDB persistence for the merch dashboard.
// Database name: `merch-dashboard`
// Stores: categories, conventions, decisions, sheet, landers, landers_meta,
//         lander_sheet, model_versions, model_versions_meta
// Public API: openDB, saveCategory, loadCategory, listCategories,
//             deleteCategory,
//             saveConvention, loadConvention, listConventions,
//             saveCategoryConvention, loadCategoryConvention,
//             listConventionsForCategory,
//             recordDecision, getRejections, clearExpiredDecisions,
//             addSheetEntry, removeSheetEntry, listSheetEntries, clearSheet,
//             putLanders, listLanders, clearLanders,
//             saveLandersMeta, loadLandersMeta
//
// The `conventions` store holds two scopes of record, distinguished by key
// shape: brand conventions are keyed `${brandId}::${categoryId}`, category
// conventions `category::${categoryId}`. Supabase is the source of truth;
// this store is a read-through cache populated by /api/conventions/list.

(function (global) {
  const DB_NAME = 'merch-dashboard';
  const DB_VERSION = 5;
  const REJECTION_TTL_DAYS = 30;

  let _dbPromise = null;

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        // v1 -> v2: data model shifted from sport-rooted to relatable-category-rooted.
        // The legacy `sports` store is dropped; users re-sync per category.
        if (db.objectStoreNames.contains('sports')) {
          db.deleteObjectStore('sports');
        }
        if (!db.objectStoreNames.contains('categories')) {
          const s = db.createObjectStore('categories', { keyPath: 'id' });
          s.createIndex('sportId', 'sportId', { unique: false });
        }
        if (!db.objectStoreNames.contains('conventions')) {
          const s = db.createObjectStore('conventions', { keyPath: 'key' });
          s.createIndex('brandId', 'brandId', { unique: false });
          s.createIndex('categoryId', 'categoryId', { unique: false });
        }
        if (!db.objectStoreNames.contains('decisions')) {
          const s = db.createObjectStore('decisions', { keyPath: 'id', autoIncrement: true });
          s.createIndex('sourceId', 'sourceId', { unique: false });
          s.createIndex('decision', 'decision', { unique: false });
          s.createIndex('expiresAt', 'expiresAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('sheet')) {
          db.createObjectStore('sheet', { keyPath: 'sourceId' });
        }
        // v2 -> v3: landers query tool. Light-projection cache of ~180k landers
        // for client-side filter/sort, plus a singleton meta record for syncedAt.
        if (!db.objectStoreNames.contains('landers')) {
          const s = db.createObjectStore('landers', { keyPath: 'id' });
          s.createIndex('slug', 'slug', { unique: false });
          s.createIndex('state', 'state', { unique: false });
          s.createIndex('type', 'type', { unique: false });
        }
        if (!db.objectStoreNames.contains('landers_meta')) {
          db.createObjectStore('landers_meta', { keyPath: 'key' });
        }
        // v3 -> v4: model_versions tool cache. Rows can run into the tens of
        // thousands for a whole category sync -- too large for localStorage.
        if (!db.objectStoreNames.contains('model_versions')) {
          const s = db.createObjectStore('model_versions', { keyPath: 'id' });
          s.createIndex('parent_model_id', 'parent_model_id', { unique: false });
        }
        if (!db.objectStoreNames.contains('model_versions_meta')) {
          db.createObjectStore('model_versions_meta', { keyPath: 'key' });
        }
        // v4 -> v5: lander bulk-action sheet. One in-progress row per lander id;
        // read-modify-write so repeated actions on the same lander dedup.
        if (!db.objectStoreNames.contains('lander_sheet')) {
          db.createObjectStore('lander_sheet', { keyPath: 'id' });
        }
      };
      // Without this, an older connection in another tab blocks the version
      // upgrade and `req.onsuccess` never fires -- openDB() hangs forever and
      // the whole app sits on a blank screen. Closing on `versionchange`
      // lets a future upgrade proceed instead of deadlocking.
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error(
        'Database upgrade is blocked by another open tab. Close other tabs running this dashboard and reload.'
      ));
    });
    return _dbPromise;
  }

  function tx(storeName, mode) {
    return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
  }

  function promisify(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // -------- categories (relatable: leaf categories with has_models=1) --------
  // Record shape:
  // {
  //   id: "37" (string),
  //   name: "Bats",
  //   fullName: "Baseball > Bats",
  //   path: "4000/37",
  //   sportId: "4000", sportName: "Baseball",
  //   models: [...],            // present once synced
  //   syncedAt: "2026-05-07T..." // present once synced
  // }
  async function saveCategory(record) {
    const store = await tx('categories', 'readwrite');
    const normalized = { ...record, id: String(record.id) };
    return promisify(store.put(normalized));
  }

  async function loadCategory(categoryId) {
    const store = await tx('categories', 'readonly');
    return promisify(store.get(String(categoryId)));
  }
  async function listCategories() {
    const store = await tx('categories', 'readonly');
    return promisify(store.getAll());
  }
  async function deleteCategory(categoryId) {
    const store = await tx('categories', 'readwrite');
    return promisify(store.delete(String(categoryId)));
  }

  // -------- conventions --------
  // Brand convention key: `${brandId}::${categoryId}`
  // Category convention key: `category::${categoryId}`
  function conventionKey(brandId, categoryId) {
    return `${brandId}::${categoryId}`;
  }
  function categoryConventionKey(categoryId) {
    return `category::${categoryId}`;
  }
  async function saveConvention(record) {
    const enriched = {
      ...record,
      categoryId: Number(record.categoryId),
      brandId: Number(record.brandId),
      key: conventionKey(record.brandId, record.categoryId),
      scope: 'brand',
    };
    const store = await tx('conventions', 'readwrite');
    return promisify(store.put(enriched));
  }
  async function loadConvention(brandId, categoryId) {
    const store = await tx('conventions', 'readonly');
    return promisify(store.get(conventionKey(brandId, categoryId)));
  }
  async function saveCategoryConvention(record) {
    const enriched = {
      ...record,
      categoryId: Number(record.categoryId),
      key: categoryConventionKey(record.categoryId),
      scope: 'category',
      brandId: null,
      brandName: null,
    };
    const store = await tx('conventions', 'readwrite');
    return promisify(store.put(enriched));
  }
  async function loadCategoryConvention(categoryId) {
    const store = await tx('conventions', 'readonly');
    return promisify(store.get(categoryConventionKey(categoryId)));
  }
  async function listConventions() {
    const store = await tx('conventions', 'readonly');
    return promisify(store.getAll());
  }
  // Cache fallback used when Supabase is unreachable. Returns the same
  // shape the /api/conventions/list endpoint returns.
  async function listConventionsForCategory(categoryId) {
    const store = await tx('conventions', 'readonly');
    const idx = store.index('categoryId');
    const all = await promisify(idx.getAll(IDBKeyRange.only(Number(categoryId))));
    // Tolerate string-typed categoryId in older cached records.
    const stringMatches = await promisify(idx.getAll(IDBKeyRange.only(String(categoryId))));
    const merged = [...all, ...stringMatches];
    const seen = new Set();
    const dedup = [];
    for (const r of merged) {
      if (seen.has(r.key)) continue;
      seen.add(r.key);
      dedup.push(r);
    }
    const category = dedup.find((r) => r.scope === 'category') || null;
    const brands = dedup.filter((r) => r.scope === 'brand');
    return { category, brands };
  }

  // -------- decisions --------
  async function recordDecision({ sourceId, targetId = null, newName = null, decision, reasoning = null }) {
    const now = new Date();
    const expires = new Date(now.getTime() + REJECTION_TTL_DAYS * 86400_000);
    const record = {
      sourceId,
      targetId,
      newName,
      decision,
      reasoning,
      decidedAt: now.toISOString(),
      expiresAt: decision === 'rejected' ? expires.toISOString() : null,
    };
    const store = await tx('decisions', 'readwrite');
    return promisify(store.add(record));
  }

  async function clearExpiredDecisions() {
    const nowIso = new Date().toISOString();
    const store = await tx('decisions', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.openCursor();
      let removed = 0;
      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return resolve(removed);
        const v = cursor.value;
        if (v.decision === 'rejected' && v.expiresAt && v.expiresAt < nowIso) {
          cursor.delete();
          removed += 1;
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  // Returns a Set of sourceIds that have unexpired rejections.
  async function getRejections() {
    await clearExpiredDecisions();
    const store = await tx('decisions', 'readonly');
    const all = await promisify(store.getAll());
    const set = new Set();
    for (const d of all) if (d.decision === 'rejected') set.add(d.sourceId);
    return set;
  }

  // Delete all 'rejected' decision records whose sourceId is in the supplied
  // iterable. Used when a convention is edited so previously-refused
  // candidates get re-evaluated against the new rules instead of staying
  // blocked for the rejection TTL. Returns the number of records removed.
  async function clearRejectionsForSourceIds(sourceIds) {
    const ids = new Set(Array.from(sourceIds || []));
    if (!ids.size) return 0;
    const store = await tx('decisions', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.openCursor();
      let removed = 0;
      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return resolve(removed);
        const v = cursor.value;
        if (v.decision === 'rejected' && ids.has(v.sourceId)) {
          cursor.delete();
          removed += 1;
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  // -------- sheet (in-progress bulk import) --------
  // Read-modify-write so layered actions (state change + rename, etc.) merge
  // into one record per sourceId instead of overwriting. Callers should pass
  // only the fields they're actually setting -- nulls would clear unrelated
  // layered actions.
  async function addSheetEntry(entry) {
    const store = await tx('sheet', 'readwrite');
    const existing = await promisify(store.get(entry.sourceId));
    const merged = {
      ...(existing || {}),
      ...entry,
      addedAt:   (existing && existing.addedAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return promisify(store.put(merged));
  }
  async function loadSheetEntry(sourceId) {
    const store = await tx('sheet', 'readonly');
    return promisify(store.get(sourceId));
  }
  async function removeSheetEntry(sourceId) {
    const store = await tx('sheet', 'readwrite');
    return promisify(store.delete(sourceId));
  }
  async function listSheetEntries() {
    const store = await tx('sheet', 'readonly');
    return promisify(store.getAll());
  }
  async function clearSheet() {
    const store = await tx('sheet', 'readwrite');
    return promisify(store.clear());
  }

  // -------- landers (lander query tool cache) --------
  // Record shape (light projection — query/display fields only):
  // { id, slug, name, title_tag, query, type, state, discoverable,
  //   available_count, page_view_id, redirect_target_id,
  //   cat_removed, model_removed, model_merged }   // linked-status flags (0/1)
  async function putLanders(rows) {
    if (!rows || !rows.length) return 0;
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction('landers', 'readwrite');
      const store = t.objectStore('landers');
      for (const r of rows) store.put(r);
      t.oncomplete = () => resolve(rows.length);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  async function listLanders() {
    const store = await tx('landers', 'readonly');
    return promisify(store.getAll());
  }
  async function clearLanders() {
    const store = await tx('landers', 'readwrite');
    return promisify(store.clear());
  }
  async function saveLandersMeta(meta) {
    const store = await tx('landers_meta', 'readwrite');
    return promisify(store.put({ key: 'singleton', ...meta }));
  }
  async function loadLandersMeta() {
    const store = await tx('landers_meta', 'readonly');
    return promisify(store.get('singleton'));
  }

  // -------- lander_sheet (in-progress lander bulk import) --------
  // Read-modify-write so layered actions merge into one record per lander id.
  // Callers pass only the fields they're setting.
  async function addLanderSheetEntry(entry) {
    const store = await tx('lander_sheet', 'readwrite');
    const existing = await promisify(store.get(entry.id));
    const merged = {
      ...(existing || {}),
      ...entry,
      addedAt:   (existing && existing.addedAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return promisify(store.put(merged));
  }
  async function removeLanderSheetEntry(id) {
    const store = await tx('lander_sheet', 'readwrite');
    return promisify(store.delete(id));
  }
  async function listLanderSheetEntries() {
    const store = await tx('lander_sheet', 'readonly');
    return promisify(store.getAll());
  }
  async function clearLanderSheet() {
    const store = await tx('lander_sheet', 'readwrite');
    return promisify(store.clear());
  }

  // -------- model versions (Model Versions tool cache) --------
  // Replaces the whole store on each sync so stale rows from a prior
  // brand/category selection don't linger. Meta is a singleton record holding
  // the last selection + syncedAt so a refresh can restore the view.
  async function putModelVersions(rows) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction('model_versions', 'readwrite');
      const store = t.objectStore('model_versions');
      store.clear();
      for (const r of (rows || [])) store.put(r);
      t.oncomplete = () => resolve((rows || []).length);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  async function listModelVersions() {
    const store = await tx('model_versions', 'readonly');
    return promisify(store.getAll());
  }
  async function clearModelVersions() {
    const store = await tx('model_versions', 'readwrite');
    return promisify(store.clear());
  }
  async function saveModelVersionsMeta(meta) {
    const store = await tx('model_versions_meta', 'readwrite');
    return promisify(store.put({ key: 'singleton', ...meta }));
  }
  async function loadModelVersionsMeta() {
    const store = await tx('model_versions_meta', 'readonly');
    return promisify(store.get('singleton'));
  }

  global.Storage = {
    openDB,
    saveCategory, loadCategory, listCategories, deleteCategory,
    saveConvention, loadConvention, listConventions, conventionKey,
    saveCategoryConvention, loadCategoryConvention, categoryConventionKey,
    listConventionsForCategory,
    recordDecision, getRejections, clearExpiredDecisions, clearRejectionsForSourceIds,
    addSheetEntry, loadSheetEntry, removeSheetEntry, listSheetEntries, clearSheet,
    putLanders, listLanders, clearLanders, saveLandersMeta, loadLandersMeta,
    addLanderSheetEntry, removeLanderSheetEntry, listLanderSheetEntries, clearLanderSheet,
    putModelVersions, listModelVersions, clearModelVersions,
    saveModelVersionsMeta, loadModelVersionsMeta,
  };
})(window);
