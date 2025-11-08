/**
 * Simple ImageDB helper (IndexedDB) used by the project.
 * Exposes:
 *  - ImageDB.openDB() -> Promise
 *  - ImageDB.saveFileOrData(input) -> Promise<key>
 *      input can be: File | Blob | dataURL string | URL string (will be fetched)
 *  - ImageDB.getObjectURL(key) -> Promise<string>  (object URL)
 *  - ImageDB.deleteByKey(key) -> Promise<void>
 *  - ImageDB.listKeys() -> Promise<string[]>
 *
 * The file path matches the scripts referenced in your HTML:
 *   <script src="assets/css/js/image-db.js"></script>
 *
 * Notes:
 *  - Keys are stable short strings generated as `img_<timestamp>_<rand>`.
 *  - getObjectURL caches created object URLs and revokes them on delete.
 *  - If you move this file, update the <script> tag(s) in your HTML.
 */

const ImageDB = (function () {
  const DB_NAME = 'ex_image_db';
  const STORE_NAME = 'files';
  const DB_VERSION = 1;

  let db = null;
  const objectUrlCache = new Map(); // key -> objectURL

  function openDB() {
    if (db) return Promise.resolve(db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (ev) {
        const idb = ev.target.result;
        if (!idb.objectStoreNames.contains(STORE_NAME)) {
          const store = idb.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('created', 'created', { unique: false });
        }
      };
      req.onsuccess = function (ev) {
        db = ev.target.result;
        // close DB when page unloads (optional)
        window.addEventListener('beforeunload', () => { try { db.close(); } catch(e){} });
        resolve(db);
      };
      req.onerror = function (ev) {
        console.error('ImageDB open failed', ev);
        reject(ev.target.error || new Error('IndexedDB open failed'));
      };
    });
  }

  function _txn(storeName, mode = 'readwrite') {
    if (!db) throw new Error('DB not open');
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    return { tx, store };
  }

  function _makeKey() {
    return 'img_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 0x10000).toString(36);
  }

  // convert dataURL to Blob
  function _dataURLToBlob(dataURL) {
    const parts = dataURL.split(',');
    const meta = parts[0] || '';
    const isBase64 = meta.indexOf(';base64') !== -1;
    const mimeMatch = meta.match(/data:([^;]+)/);
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    const raw = isBase64 ? atob(parts[1]) : decodeURIComponent(parts[1]);
    const u8 = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; ++i) u8[i] = raw.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }

  // fetch a URL and return blob
  async function _fetchToBlob(url) {
    const res = await fetch(url, {mode: 'cors'});
    if (!res.ok) throw new Error('failed to fetch ' + url + ' status:' + res.status);
    return await res.blob();
  }

  /**
   * Save File/Blob/dataURL/or URL (fetched) into IndexedDB.
   * Returns a key string to reference the stored blob.
   */
  async function saveFileOrData(input, name) {
    await openDB();
    let blob;
    let type = '';
    let fileName = name || '';

    if (!input) throw new Error('no input');

    if (input instanceof Blob || input instanceof File) {
      blob = input;
      type = blob.type || '';
      if (input instanceof File && input.name) fileName = input.name;
    } else if (typeof input === 'string') {
      const trimmed = input.trim();
      if (trimmed.indexOf('data:') === 0) {
        blob = _dataURLToBlob(trimmed);
        type = blob.type || '';
      } else if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
        // treat as URL - try fetch
        blob = await _fetchToBlob(trimmed);
        type = blob.type || '';
      } else {
        // unknown string -> treat as dataURL error
        throw new Error('Unsupported string input for saveFileOrData. Provide dataURL or a URL/path.');
      }
    } else {
      throw new Error('Unsupported input type for saveFileOrData');
    }

    const key = _makeKey();
    const item = {
      id: key,
      blob,
      name: fileName || key,
      type: type || '',
      created: new Date().toISOString()
    };

    return new Promise((resolve, reject) => {
      try {
        const { tx, store } = _txn(STORE_NAME, 'readwrite');
        const req = store.add(item);
        req.onsuccess = function () {
          resolve(key);
        };
        req.onerror = function (ev) {
          reject(ev.target.error || new Error('Failed to save file'));
        };
      } catch (err) { reject(err); }
    });
  }

  /**
   * Get an object URL for a stored key.
   * Creates and caches a URL via URL.createObjectURL(blob).
   * Resolves to a string or empty string on failure.
   */
  async function getObjectURL(key) {
    if (!key) return '';
    // return cached
    if (objectUrlCache.has(key)) return objectUrlCache.get(key);
    await openDB();
    return new Promise((resolve, reject) => {
      try {
        const { tx, store } = _txn(STORE_NAME, 'readonly');
        const req = store.get(key);
        req.onsuccess = function (ev) {
          const rec = ev.target.result;
          if (!rec || !rec.blob) return resolve('');
          try {
            const url = URL.createObjectURL(rec.blob);
            objectUrlCache.set(key, url);
            resolve(url);
          } catch (err) {
            console.warn('createObjectURL failed', err);
            resolve('');
          }
        };
        req.onerror = function (ev) {
          reject(ev.target.error || new Error('Failed to read file'));
        };
      } catch (err) { reject(err); }
    });
  }

  /**
   * Delete a stored key and revoke any cached objectURL.
   */
  async function deleteByKey(key) {
    if (!key) return;
    await openDB();
    return new Promise((resolve, reject) => {
      try {
        const { tx, store } = _txn(STORE_NAME, 'readwrite');
        const req = store.delete(key);
        req.onsuccess = function () {
          // revoke cached object URL if any
          const url = objectUrlCache.get(key);
          if (url) {
            try { URL.revokeObjectURL(url); } catch (e) {}
            objectUrlCache.delete(key);
          }
          resolve();
        };
        req.onerror = function (ev) { reject(ev.target.error || new Error('Failed to delete key')); };
      } catch (err) { reject(err); }
    });
  }

  /**
   * listKeys - returns all keys stored (id strings)
   */
  async function listKeys() {
    await openDB();
    return new Promise((resolve, reject) => {
      try {
        const { tx, store } = _txn(STORE_NAME, 'readonly');
        const req = store.getAllKeys();
        req.onsuccess = function (ev) { resolve(ev.target.result || []); };
        req.onerror = function (ev) { reject(ev.target.error || new Error('Failed to get keys')); };
      } catch (err) { reject(err); }
    });
  }

  // expose public API
  return {
    openDB,
    saveFileOrData,
    getObjectURL,
    deleteByKey,
    listKeys
  };
})();