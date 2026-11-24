/**
 * Persistent Offline IndexedDB Vault for Recently Opened STL Models.
 * Stores up to 15 models / 64 MB total with LRU eviction; fails gracefully in private windows.
 */

const DB_NAME = 'stlviewer_web_vault_v1';
const STORE_NAME = 'models';
const MAX_ITEMS = 15;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listRecentModels() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        const items = (req.result || [])
          .map(({ id, name, triCount, fileBytes, extent, updatedAt }) => ({
            id, name, triCount, fileBytes, extent, updatedAt,
          }))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function getRecentModelBuffer(id) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function saveRecentModel({ name, buffer, triCount, extent }) {
  if (!buffer || buffer.byteLength === 0 || buffer.byteLength > 25 * 1024 * 1024) return null;
  try {
    const db = await openDb();
    const id = `${name}::${buffer.byteLength}`;
    const entry = {
      id,
      name,
      buffer: buffer.slice(0),
      triCount: triCount || 0,
      fileBytes: buffer.byteLength,
      extent: extent ? { x: extent.x, y: extent.y, z: extent.z } : null,
      updatedAt: Date.now(),
    };

    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(entry);
      const getAllReq = store.getAll();
      getAllReq.onsuccess = () => {
        const all = (getAllReq.result || []).sort((a, b) => b.updatedAt - a.updatedAt);
        let bytes = 0;
        for (let i = 0; i < all.length; i++) {
          bytes += all[i].fileBytes || 0;
          if (i >= MAX_ITEMS || bytes > MAX_TOTAL_BYTES) {
            store.delete(all[i].id);
          }
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return id;
  } catch {
    return null;
  }
}

export async function deleteRecentModel(id) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}

export async function clearRecentModels() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}
