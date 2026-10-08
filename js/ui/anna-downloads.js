import { h, sheet } from './dom.js';
import { sourceLink } from './links.js';
import { githubJob, hasGithubSession } from '../sources/github-jobs.js';
import { matchingTorboxFiles, torrentUrl } from '../sources/anna-downloads.js';
import { readDownloadBytes, safeFilename, saveBlob } from '../downloads.js';
import { importFiles } from '../importers.js';

export function annaDownloadOptions(entry) {
  const body = h('section', {}, h('h2', {}, 'Downloads'));
  const status = h('p', { class: 'muted', role: 'status' });
  const results = h('div', { class: 'menu' });
  const collection = h('select', { 'aria-label': 'Anna download TorBox collection' }, ['torrents', 'webdl', 'usenet'].map((kind) => h('option', { value: kind }, kind)));
  const find = h('button', { class: 'btn', onClick: async () => {
    find.disabled = true; status.textContent = 'Checking your TorBox files for this record…';
    try {
      const data = await githubJob('torbox/list', { kind: collection.value });
      const matches = matchingTorboxFiles(entry, data.items);
      results.replaceChildren(...matches.map((file) => h('button', { class: 'btn', disabled: !file.ready, onClick: () => fileActions(entry, file) },
        `${file.name.split('/').pop()} · ${(file.size / 1e6).toFixed(1)} MB · ${file.ready ? 'Download' : 'Not ready'}`)));
      status.textContent = matches.length ? `${matches.length} matching file(s).` : 'No matching files in this collection. Submit a mapped torrent below, or open Anna’s source record for other mirrors.';
    } catch (error) { status.textContent = error.message; }
    finally { find.disabled = false; }
  } }, 'Find file in TorBox');
  body.append(h('p', { class: 'muted' }, 'The metadata is not the book. Available torrent mappings can retrieve files through TorBox. Some files have no mapped torrent or are packed inside larger archives.'),
    h('div', { class: 'import' }, collection, find), status, results);
  for (const torrent of entry.torrents || []) {
    const state = h('p', { class: 'muted', role: 'status' });
    const actions = h('div', { class: 'import' }, sourceLink('Download torrent ↗', torrentUrl(torrent.path)));
    const inspect = h('button', { class: 'btn', onClick: async () => {
      if (!hasGithubSession()) { state.textContent = 'Connect your GitHub session in Settings first.'; return; }
      inspect.disabled = true; state.textContent = 'Inspecting public torrent metadata…';
      try {
        const info = await githubJob('anna/torrent-info', { torrentPath: torrent.path });
        state.textContent = `Whole torrent: ${(info.size / 1e9).toFixed(2)} GB across ${info.files} files. TorBox downloads the whole torrent; account limits apply.${!torrent.file ? ' The metadata identifies this torrent but not the exact book file inside it. File selection or archive extraction must be done manually.' : torrent.packedFile ? ' This book is inside an archive and needs extraction after download.' : ''}`;
        if (info.size > 1e12) { state.append(' Too large for TorBox.'); return; }
        const submit = h('button', { class: 'btn', onClick: async () => {
          submit.disabled = true; state.textContent = 'Submitting the selected torrent to TorBox…';
          try {
            await githubJob('torbox/add-anna', { torrentPath: torrent.path, expectedHash: info.hash });
            state.textContent = 'Submitted to TorBox. Use Find file in TorBox when the download is ready.';
            submit.textContent = 'Submitted';
          } catch (error) { state.textContent = error.message; submit.disabled = false; }
        } }, `Download with TorBox (${(info.size / 1e9).toFixed(2)} GB)`);
        actions.append(submit);
      } catch (error) { state.textContent = error.message; }
      finally { inspect.disabled = false; }
    } }, 'Inspect torrent');
    actions.append(inspect); body.append(h('div', {}, h('p', {}, torrent.collection || torrent.path.split('/').pop()), actions, state));
  }
  if (!entry.torrents?.length) body.append(h('p', { class: 'muted' }, 'No torrent mapping was included in this record. Anna’s source page may offer other downloads.'));
  return body;
}
function fileActions(entry, file) {
  const extension = /^[a-z\d]{1,8}$/i.test(entry.extension || '') ? entry.extension.toLowerCase() : '';
  const filename = safeFilename(entry.title, extension);
  const status = h('p', { class: 'muted', role: 'status' }), links = h('div', { class: 'import' });
  async function getFile(read) {
    download.disabled = readButton.disabled = true;
    try {
      status.textContent = 'Generating a temporary download link…';
      const { url } = await githubJob('torbox/download', { kind: file.kind, id: file.downloadId, fileId: file.id });
      links.replaceChildren(sourceLink('Open direct download ↗', url, 'btn', filename));
      if (file.size > 200 * 1024 * 1024) { status.textContent = 'Use the direct download for files above 200 MB, then import manually.'; return; }
      const bytes = await readDownloadBytes(url, { onProgress: (size) => { status.textContent = `Downloading ${(size / 1e6).toFixed(1)} MB…`; } });
      if (read) {
        const result = await importFiles([new File([bytes], filename)], entry.type || 'book');
        if (result.errors.length || !result.added.length) throw new Error(result.errors.join(' ') || 'The file could not be imported.');
        close(); location.hash = `#/read/${encodeURIComponent(result.added[0].id)}`;
      } else { saveBlob(new Blob([bytes]), filename); status.textContent = 'File download started. No temporary link was persisted.'; }
    } catch (error) { status.textContent = error instanceof TypeError ? 'The file server blocked browser access. Use the direct download link.' : error.message; }
    finally { download.disabled = readButton.disabled = false; }
  }
  const download = h('button', { class: 'btn', onClick: () => getFile(false) }, 'Download file');
  const readButton = h('button', { class: 'btn', onClick: () => getFile(true) }, 'Import and read');
  const close = sheet(entry.title, h('div', { class: 'menu' }, download, readButton, status, links));
}
