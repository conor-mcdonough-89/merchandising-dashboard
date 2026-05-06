// storage.js — IndexedDB persistence for the merch dashboard.
// Database name: `merch-dashboard`
// Stores: sports, conventions, decisions, sheet
// Public API: openDB, saveSport, loadSport, listSports, deleteSport,
//             saveConvention, loadConvention, listConventions,
//             recordDecision, getRejections, clearExpiredDecisions,
//             addSheetEntry, removeSheetEntry, listSheetEntries, clearSheet

(function (global) {
  const DB_NAME = 'merch-dashboard';
  const DB_VERSION = 1;
  const REJECTION_TTL_DAYS = 30;

  let _dbPromise = null;

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (!db.objectStoreNames.contains('sports')) {
          db.createObjectStore('sports', { keyPath: 'id' });
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

  // -------- sports --------
  async function saveSport(record) {
    const store = await tx('sports', 'readwrite');
    return promisify(store.put(record));
  }
  async function loadSport(sportId) {
    const store = await tx('sports', 'readonly');
    return promisify(store.get(String(sportId)));
  }
  async function listSports() {
    const store = await tx('sports', 'readonly');
    return promisify(store.getAll());
  }
  async function deleteSport(sportId) {
    const store = await tx('sports', 'readwrite');
    return promisify(store.delete(String(sportId)));
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
    saveSport, loadSport, listSports, deleteSport,
    saveConvention, loadConvention, listConventions, conventionKey,
    recordDecision, getRejections, clearExpiredDecisions,
    addSheetEntry, removeSheetEntry, listSheetEntries, clearSheet,
  };
})(window);
