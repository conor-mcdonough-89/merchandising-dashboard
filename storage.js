// storage.js — IndexedDB persistence for the merch dashboard.
// Database name: `merch-dashboard`
// Stores: categories, conventions, decisions, sheet
// Public API: openDB, saveCategory, loadCategory, listCategories,
//             deleteCategory,
//             saveConvention, loadConvention, listConventions,
//             recordDecision, getRejections, clearExpiredDecisions,
//             addSheetEntry, removeSheetEntry, listSheetEntries, clearSheet

(function (global) {
  const DB_NAME = 'merch-dashboard';
  const DB_VERSION = 2;
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
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
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
  function conventionKey(brandId, categoryId) {
    return `${brandId}::${categoryId}`;
  }
  async function saveConvention(record) {
    const enriched = { ...record, key: conventionKey(record.brandId, record.categoryId) };
    const store = await tx('conventions', 'readwrite');
    return promisify(store.put(enriched));
  }
  async function loadConvention(brandId, categoryId) {
    const store = await tx('conventions', 'readonly');
    return promisify(store.get(conventionKey(brandId, categoryId)));
  }
  async function listConventions() {
    const store = await tx('conventions', 'readonly');
    return promisify(store.getAll());
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

  // -------- sheet (in-progress bulk import) --------
  async function addSheetEntry(entry) {
    const store = await tx('sheet', 'readwrite');
    const enriched = { ...entry, addedAt: entry.addedAt || new Date().toISOString() };
    return promisify(store.put(enriched));
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

  global.Storage = {
    openDB,
    saveCategory, loadCategory, listCategories, deleteCategory,
    saveConvention, loadConvention, listConventions, conventionKey,
    recordDecision, getRejections, clearExpiredDecisions,
    addSheetEntry, removeSheetEntry, listSheetEntries, clearSheet,
  };
})(window);
