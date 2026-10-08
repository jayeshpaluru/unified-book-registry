import { h } from './dom.js';
import { githubJob, hasGithubSession } from '../sources/github-jobs.js';
import { connectIndex, connectedIndex, disconnectIndex } from '../sources/anna-index.js';
import { catalogMode } from '../sources/catalog-api.js';

export function annaIndexSettings(onChange) {
  const state = h('p', { class: 'muted', role: 'status' }, connectedIndex() ? 'A TorBox metadata index is connected for this tab.' : 'No full metadata index connected.');
  const files = h('div', { class: 'menu' });
  const collection = h('select', { 'aria-label': 'Anna index TorBox collection' }, ['torrents', 'webdl', 'usenet'].map((kind) => h('option', { value: kind }, kind)));
  let busy = false;
  const load = h('button', { class: 'btn', onClick: async () => {
    if (await catalogMode() !== 'static') { state.textContent = 'Choose Static catalog + GitHub Actions mode above to use the browser index.'; return; }
    if (!hasGithubSession()) { state.textContent = 'Connect your GitHub session in Settings first.'; return; }
    if (busy) return; busy = true; load.disabled = true;
    state.textContent = 'Loading SQLite metadata index files from TorBox…';
    try {
      const { items } = await githubJob('torbox/list', { kind: collection.value });
      const indexes = items.flatMap((download) => (download.files || []).filter((file) => /\.(sqlite|sqlite3|db)$/i.test(file.name))
        .map((file) => ({ ...file, kind: download.kind, downloadId: download.id, ready: download.ready })));
      files.replaceChildren(...indexes.map((file) => h('button', { class: 'btn', disabled: !file.ready, onClick: async () => {
        if (busy) return; busy = true; state.textContent = 'Opening the selected metadata index with browser byte ranges…';
        try {
          const { url } = await githubJob('torbox/download', { kind: file.kind, id: file.downloadId, fileId: file.id });
          const { manifest, stats } = await connectIndex(url, { size: Number(file.size) || 0 });
          state.textContent = `Connected for this tab: ${manifest.records.toLocaleString()} records · snapshot ${manifest.snapshot} · ${manifest.shards.length}/12 shards · ${manifest.complete ? 'complete selected snapshot' : 'partial index'} · ${(stats.bytes / 1024).toFixed(0)} KB fetched to open.`;
          await onChange();
        } catch (error) { state.textContent = error.message; }
        finally { busy = false; }
      } }, `${file.name.split('/').pop()} · ${(file.size / 1e9).toFixed(2)} GB · ${file.ready ? 'Connect for this tab' : 'Not ready'}`)));
      state.textContent = indexes.length ? `${indexes.length} SQLite file(s). Choose a finalized registry index, not an active database or raw metadata dump.`
        : 'No SQLite index files found in this collection. The 167 GB metadata download must be imported and exported before a full index can be stored here.';
    } catch (error) { state.textContent = error.message; }
    finally { busy = false; load.disabled = false; }
  } }, 'Load Anna index files from TorBox');
  return h('section', {}, h('h2', {}, 'Full Anna metadata index (TorBox storage)'),
    h('p', { class: 'muted' }, 'Read a finalized metadata-only SQLite index directly from TorBox in this browser. The database does not go into Pages or download in full. Its file server must allow CORS byte ranges and expose Content-Range. Broad searches have time and download limits.'),
    h('div', { class: 'import' }, collection, load, h('button', { class: 'btn', onClick: async () => {
      disconnectIndex(); state.textContent = 'Index disconnected. The Pages catalog and local browser imports are still available.'; await onChange();
    } }, 'Disconnect Anna index')), state, files,
    h('p', { class: 'muted' }, 'Index links and downloaded pages stay only in this tab’s memory, outside library backups. Reconnect after reloading or link expiry. No TorBox API key enters the browser; requesting the file list and link uses the same encrypted Actions flow as TorBox downloads.'));
}
