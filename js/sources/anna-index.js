let worker, metadata, lastStats;
const pending = new Map(); let nextId = 0;
export const connectedIndex = () => metadata;
export const indexStats = () => lastStats;
export function disconnectIndex() {
  worker?.terminate(); worker = null; metadata = null; lastStats = null;
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Index disconnected.')); }
  pending.clear();
}
function request(action, params) {
  if (!worker) return Promise.reject(new Error('Connect your TorBox metadata index first.'));
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { disconnectIndex(); reject(new Error('Index operation timed out. Reconnect and use a more specific search.')); }, 35000);
    pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, action, params });
  });
}
export async function connectIndex(url, { size = 0 } = {}) {
  disconnectIndex();
  worker = new Worker(new URL('./anna-index-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data: { id, value, error } }) => {
    const task = pending.get(id); if (!task) return;
    pending.delete(id); clearTimeout(task.timer);
    if (error) task.reject(new Error(error)); else { lastStats = value.stats; task.resolve(value); }
  };
  worker.onerror = () => { for (const task of pending.values()) task.reject(new Error('The browser index runtime could not load. Reconnect or use the local catalog.')); disconnectIndex(); };
  try { const result = await request('connect', { url, size }); metadata = result.manifest; return result; }
  catch (error) { disconnectIndex(); throw error; }
}
export const searchIndex = (query, offset = 0, type) => request('search', { query, offset, type });
