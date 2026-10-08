import { h, sheet } from './dom.js';
import * as db from '../db.js';
import { removeItem } from '../items.js';
import { saveBlob, safeFilename, chapterCbz } from '../downloads.js';
import { loadPages } from '../sources/mangadex.js';
import { loadDownloads } from '../sources/archive.js';
import { sourceLink } from './links.js';

const MODES = [['ltr', 'Left to right'], ['rtl', 'Right to left'], ['vertical', 'Vertical scroll']];

// Long-press / "…" menu: mark read, reading direction, delete (with in-page confirm).
export function openItemMenu(item, onChange) {
  let close;
  const done = () => { close(); onChange(); };
  const act = (fn) => async () => { await fn(); done(); };
  const body = h('div', { class: 'menu' });
  const download = async () => {
    const status = h('p', { class: 'muted', role: 'status' }, 'Preparing download…'); body.append(status);
    try {
      const local = await db.getBlob(item.id);
      if (local) { saveBlob(local, local.name || safeFilename(item.title, item.format === 'text' ? 'txt' : item.format)); status.textContent = 'Original file download started.'; }
      else if (item.format === 'mangadex') {
        const blob = await chapterCbz(await loadPages(item.chapterId), { title: item.title,
          credits: `MangaDex; ${(item.scanlationGroups || []).map((group) => group.name).join(', ')}`,
          onProgress: ({ pages, totalPages }) => { status.textContent = `Downloading page ${pages}/${totalPages}…`; } });
        saveBlob(blob, safeFilename(item.title, 'cbz')); status.textContent = 'CBZ download started.';
      } else if (item.format === 'ia') {
        const files = await loadDownloads(item.iaId); status.replaceChildren(...files.map((file) => sourceLink(`Download ${file.format} ↗`, file.url, 'btn', file.name)));
        if (!files.length) status.textContent = 'This item has no unrestricted supported downloads. Use its source reader.';
      } else status.textContent = 'Use this catalog entry’s source or TorBox download options.';
    } catch (error) { status.textContent = error instanceof TypeError ? 'The provider blocked browser download. Open its source reader.' : error.message; }
  };

  const showMain = () => {
    body.replaceChildren(
      h('button', {
        class: 'btn', onClick: act(() => db.patchItem(item.id, item.read
          ? { read: false, progress: { ...item.progress, pct: 0, page: 0, cfi: undefined } }
          : { read: true, progress: { ...item.progress, pct: 1 } })),
      }, item.read ? 'Mark unread' : 'Mark read'),
      item.type !== 'book' && h('div', { class: 'menu-group' }, h('p', { class: 'muted' }, 'Reading direction'),
        MODES.map(([mode, text]) => h('button', {
          class: `btn${item.mode === mode ? ' on' : ''}`, onClick: act(() => db.patchItem(item.id, { mode })),
        }, text))),
      item.format !== 'catalog' && item.format !== 'pse' && h('button', { class: 'btn', onClick: download }, 'Download file'),
      h('button', { class: 'btn danger', onClick: showConfirm }, 'Delete…'));
  };
  const showConfirm = () => body.replaceChildren(
    h('p', {}, `Delete "${item.title}" from this device? Reading progress is lost.`),
    h('button', { class: 'btn danger', onClick: act(() => removeItem(item.id)) }, 'Delete'),
    h('button', { class: 'btn', onClick: showMain }, 'Cancel'));

  showMain();
  close = sheet(item.title, body);
}
