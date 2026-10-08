import { h, showError } from './dom.js';
import * as db from '../db.js';
import { debounce } from '../util.js';
import { DEFAULT_MODES } from '../items.js';
import { openPageSource } from '../reader/page-source.js';
import { mountImageReader } from '../reader/image-reader.js';
import { mountBookReader } from '../reader/book-reader.js';
import { mountCatalogReference } from './catalog-view.js';

const SAVE_DELAY_MS = 800;

// Opens an item in the right reader. Returns { destroy } once mounted.
export async function openReader(host, id, onClose) {
  const item = await db.getItem(id);
  if (!item) {
    showError(host, 'This item is no longer in your library.');
    host.append(h('button', { class: 'btn', onClick: onClose }, 'Back'));
    return { destroy() {} };
  }
  if (item.format === 'catalog') return mountCatalogReference(host, item, onClose);
  host.replaceChildren(h('div', { class: 'status' }, 'Opening…'));

  let latest = null;
  const flushNow = () => {
    if (latest) db.patchItem(id, latest);
    latest = null;
  };
  const save = debounce(flushNow, SAVE_DELAY_MS);
  const queue = (patch) => {
    latest = { ...latest, ...patch, lastRead: Date.now() };
    save();
  };
  const onHide = () => document.hidden && save.flush();
  document.addEventListener('visibilitychange', onHide);

  let reader;
  const finish = () => {
    document.removeEventListener('visibilitychange', onHide);
    flushNow();
    reader?.destroy();
  };

  try {
    if (item.format === 'epub' || item.format === 'text' || item.format === 'html') {
      const blob = await db.getBlob(id);
      if (!blob) throw new Error('The stored file is missing. Delete this entry and import it again.');
      reader = await mountBookReader(host, {
        item, blob, onClose,
        onProgress: (p) => queue({ progress: { ...item.progress, ...p }, ...(p.pct > 0.985 && { read: true }) }),
      });
    } else {
      const source = await openPageSource(item);
      const modes = await db.getSetting('readingModes', DEFAULT_MODES);
      const start = item.read ? 0 : item.progress?.page ?? 0;
      reader = mountImageReader(host, {
        item: { ...item, mode: item.mode || modes[item.type] || 'ltr', progress: { ...item.progress, page: start } },
        source, onClose,
        onSettings: (patch) => db.patchItem(id, patch),
        onPage: (page, count) => queue({
          progress: { pct: count > 1 ? page / (count - 1) : 1, page, total: count },
          ...(page >= count - 1 && { read: true }),
        }),
      });
    }
  } catch (e) {
    showError(host, `Could not open "${item.title}": ${e.message}`, () => openReader(host, id, onClose));
  }
  return { destroy: finish };
}
