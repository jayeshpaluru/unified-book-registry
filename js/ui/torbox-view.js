import { h, sheet, toast } from './dom.js';
import { card } from './grid.js';
import { sourceLink } from './links.js';
import { githubJob, hasGithubSession } from '../sources/github-jobs.js';
import { importFiles } from '../importers.js';
import { readDownloadBytes, safeFilename, saveBlob } from '../downloads.js';

export function mountTorboxBrowse(view, type) {
  let disposed = false, downloads = [];
  const status = h('p', { class: 'muted', role: 'status' });
  const grid = h('div', { class: 'grid' });
  const input = h('input', { type: 'search', placeholder: 'Search your TorBox files', 'aria-label': 'Search TorBox files', onInput: render });
  const collection = h('select', { 'aria-label': 'TorBox collection' }, [['torrents', 'Torrents'], ['webdl', 'Web downloads'], ['usenet', 'Usenet']]
    .map(([value, name]) => h('option', { value }, name)));
  const load = h('button', { class: 'btn', onClick: refresh }, 'Load TorBox library');
  view.replaceChildren(h('h1', {}, 'TorBox library'),
    h('p', { class: 'muted' }, 'Private file browsing and fresh download links run through authenticated GitHub Actions. The TorBox key never reaches this page.'),
    h('div', { class: 'import' }, collection, load, h('a', { class: 'btn', href: '#/settings' }, 'Connect GitHub session')),
    input, status, grid,
    h('p', { class: 'muted' }, 'TorBox is cached storage, not a permanent backup. Use AirLock where available and keep a separate backup.'),
    sourceLink('Open TorBox dashboard ↗', 'https://torbox.app/dashboard'));

  async function refresh() {
    if (!hasGithubSession()) { status.textContent = 'Connect a repository-scoped GitHub token in Settings, then load your library.'; return; }
    load.disabled = true; status.textContent = 'Requesting your private file list…';
    try {
      const result = await githubJob('torbox/list', { kind: collection.value }, { onProgress: (text) => { if (!disposed) status.textContent = text; } });
      if (disposed) return;
      downloads = result.items; render();
    } catch (error) { if (!disposed) status.textContent = error.message; }
    finally { load.disabled = false; }
  }
  function render() {
    const pattern = type === 'book' ? /\.(epub|pdf|txt|html?)$/i : /\.(cbz|zip|cbr|rar|pdf)$/i;
    const query = input.value.trim().toLowerCase();
    const files = downloads.flatMap((download) => download.files.filter((file) => pattern.test(file.name || ''))
      .map((file) => ({ ...file, kind: download.kind, downloadId: download.id, ready: download.ready })))
      .filter((file) => (file.name || '').toLowerCase().includes(query));
    status.textContent = `${files.length.toLocaleString()} matching files${files.length > 500 ? ' · showing the first 500' : ''}.`;
    grid.replaceChildren(...files.slice(0, 500).map((file) => card({ title: file.name.split('/').pop(),
      sub: `${(file.size / 1024 / 1024).toFixed(1)} MB · ${file.ready ? 'Ready' : 'Not ready'}`, onOpen: () => details(file) })));
  }
  function details(file) {
    const state = h('p', { class: 'muted', role: 'status' });
    const actions = h('div', { class: 'import' });
    const fetchLink = async (read) => {
      button.disabled = readButton.disabled = true;
      state.textContent = 'Generating a private download link…';
      try {
        const { url } = await githubJob('torbox/download', { kind: file.kind, id: file.downloadId, fileId: file.id },
          { onProgress: (text) => { state.textContent = text; } });
        const filename = safeFilename(file.downloadFilename || file.name.split('/').pop());
        const save = h('button', { class: 'btn', onClick: async () => {
          save.disabled = true; state.textContent = 'Downloading file…';
          try {
            const bytes = await readDownloadBytes(url, { onProgress: (size) => { state.textContent = `Downloading ${(size / 1024 / 1024).toFixed(1)} MB…`; } });
            saveBlob(new Blob([bytes]), filename); state.textContent = 'File download started. The link was not saved.';
          } catch (error) { state.textContent = error instanceof TypeError ? 'Browser download was blocked. Use Open fresh download, then save the file.' : error.message; }
          finally { save.disabled = false; }
        } }, 'Download file');
        actions.replaceChildren(sourceLink('Open fresh download ↗', url, 'btn', filename), file.size <= 200 * 1024 * 1024 && save);
        if (!read) { state.textContent = 'This temporary link stays only in this browser session.'; return; }
        if (file.size > 200 * 1024 * 1024) throw new Error('For files over 200 MB, download and import manually to avoid exhausting browser memory.');
        state.textContent = 'Importing the file into your local browser library…';
        const bytes = await readDownloadBytes(url);
        const result = await importFiles([new File([bytes], filename)], type);
        if (result.errors.length) throw new Error(result.errors.join(' '));
        close(); location.hash = `#/read/${encodeURIComponent(result.added[0].id)}`;
      } catch (error) {
        state.textContent = error instanceof TypeError ? 'TorBox’s file server blocked browser import. Use the download link, then Import files in Library.' : error.message;
      } finally { button.disabled = readButton.disabled = !file.ready; }
    };
    const button = h('button', { class: 'btn', disabled: !file.ready, onClick: () => fetchLink(false) }, 'Generate download link');
    const readButton = h('button', { class: 'btn', disabled: !file.ready, onClick: () => fetchLink(true) }, 'Import and read here');
    const close = sheet(file.name.split('/').pop(), h('div', {}, h('p', {}, `${(file.size / 1024 / 1024).toFixed(1)} MB`),
      h('div', { class: 'import' }, button, readButton), state, actions));
  }
  return () => { disposed = true; };
}
