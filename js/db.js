// The single persistence layer: items, file blobs, settings, OPDS sources.
const NAME = 'ubr';
const STORES = { items: 'id', sources: 'id', blobs: null, settings: null };

let opening;
function open() {
  opening ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => {
      for (const [store, keyPath] of Object.entries(STORES)) {
        req.result.createObjectStore(store, keyPath ? { keyPath } : undefined);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

async function run(store, mode, fn) {
  const database = await open();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const get = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const all = (store) => run(store, 'readonly', (s) => s.getAll());
export const put = (store, value, key) => run(store, 'readwrite', (s) => s.put(value, key));
export const remove = (store, key) => run(store, 'readwrite', (s) => s.delete(key));

export async function getSetting(key, fallback) {
  const v = await get('settings', key);
  return v === undefined ? fallback : v;
}
export const setSetting = (key, value) => put('settings', value, key);

export const getItem = (id) => get('items', id);
export const allItems = () => all('items');
export const putItem = (item) => put('items', item);
export const getBlob = (id) => get('blobs', id);
export const putBlob = (id, blob) => put('blobs', blob, id);

export async function patchItem(id, patch) {
  const item = await getItem(id);
  if (!item) return null;
  const next = { ...item, ...patch };
  await putItem(next);
  return next;
}

export async function deleteItem(id) {
  await remove('items', id);
  await remove('blobs', id);
}

export async function clearAll() {
  const database = await open();
  const names = Object.keys(STORES);
  await new Promise((resolve, reject) => {
    const tx = database.transaction(names, 'readwrite');
    names.forEach((n) => tx.objectStore(n).clear());
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

// Library metadata only: no file blobs and no cover images.
export async function exportMetadata() {
  const items = (await allItems()).map(({ cover, ...rest }) => rest);
  const sources = (await all('sources')).map(({ pass, ...rest }) => rest);
  const database = await open();
  const settings = await new Promise((resolve, reject) => {
    const tx = database.transaction('settings', 'readonly');
    const store = tx.objectStore('settings');
    const keys = store.getAllKeys();
    const values = store.getAll();
    tx.oncomplete = () => resolve(Object.fromEntries(keys.result.map((k, i) => [k, values.result[i]])));
    tx.onerror = () => reject(tx.error);
  });
  return { version: 1, exportedAt: Date.now(), items, sources, settings };
}

// Restores settings and sources, remote items (no file needed), and progress
// for items that already exist locally. Returns counts.
export async function importMetadata(data) {
  if (data?.version !== 1 || !Array.isArray(data.items)) throw new Error('Not a Unified Book Registry export.');
  let restored = 0;
  let skipped = 0;
  for (const item of data.items) {
    const existing = await getItem(item.id);
    if (existing) {
      await putItem({ ...existing, progress: item.progress, read: item.read, lastRead: item.lastRead, mode: item.mode });
      restored++;
    } else if (['ia', 'pse', 'catalog', 'mangadex'].includes(item.format)) {
      await putItem(item);
      restored++;
    } else {
      skipped++;
    }
  }
  for (const s of data.sources || []) {
    const existing = await get('sources', s.id);
    await put('sources', { ...s, pass: existing?.pass || '' });
  }
  for (const [k, v] of Object.entries(data.settings || {})) await setSetting(k, v);
  return { restored, skipped };
}
