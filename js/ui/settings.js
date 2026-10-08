import { h, toast } from './dom.js';
import * as db from '../db.js';
import { DEFAULT_MODES } from '../items.js';
import { catalogSettings } from './catalog-settings.js';

const MODE_OPTIONS = [['ltr', 'Paged, left to right'], ['rtl', 'Paged, right to left'], ['vertical', 'Vertical scroll']];

const formatBytes = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);

export async function renderSettings(view) {
  const modes = await db.getSetting('readingModes', DEFAULT_MODES);
  const sources = await db.all('sources');
  const catalogs = await catalogSettings();
  const reload = () => renderSettings(view);

  const modeRow = (type, text) => h('label', { class: 'field' }, h('span', {}, text),
    h('select', { onChange: (e) => db.setSetting('readingModes', { ...modes, [type]: e.target.value }) },
      MODE_OPTIONS.map(([v, t]) => h('option', { value: v, selected: modes[type] === v }, t))));

  // OPDS add form
  const f = {};
  const field = (key, label, props = {}) => h('label', { class: 'field' }, h('span', {}, label),
    (f[key] = h('input', { autocomplete: 'off', autocapitalize: 'off', ...props })));
  const form = h('form', {
    class: 'opds-form',
    onSubmit: async (e) => {
      e.preventDefault();
      await db.put('sources', {
        id: crypto.randomUUID(), name: f.name.value.trim() || new URL(f.url.value).host,
        url: f.url.value.trim(), user: f.user.value.trim(), pass: f.pass.value,
      });
      reload();
    },
  },
  field('name', 'Name', { placeholder: 'My Komga' }),
  field('url', 'Catalog URL', { type: 'url', required: true, placeholder: 'https://komga.example.com/opds/v1.2/catalog' }),
  field('user', 'Username (optional)'),
  field('pass', 'Password (optional)', { type: 'password' }),
  h('button', { class: 'btn', type: 'submit' }, 'Add source'));

  const storage = h('p', { class: 'muted' }, 'Calculating…');
  navigator.storage?.estimate?.().then(({ usage, quota }) => {
    storage.textContent = `${formatBytes(usage)} used of ${formatBytes(quota)} available.`;
  }).catch(() => { storage.textContent = 'Storage usage is unavailable.'; });

  const exportJson = async () => {
    const blob = new Blob([JSON.stringify(await db.exportMetadata(), null, 1)], { type: 'application/json' });
    const file = new File([blob], 'unified-book-registry.json', { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] }).catch((e) => e.name !== 'AbortError' && toast(e.message));
    } else {
      const a = h('a', { href: URL.createObjectURL(blob), download: file.name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  };
  const importJson = h('input', {
    type: 'file', accept: 'application/json,.json', hidden: true,
    onChange: async (e) => {
      try {
        const { restored, skipped } = await db.importMetadata(JSON.parse(await e.target.files[0].text()));
        toast(`Restored ${restored} item${restored === 1 ? '' : 's'}${skipped ? `; ${skipped} need their files re-imported` : ''}.`, 6000);
        reload();
      } catch (err) {
        toast(`Import failed: ${err.message}`, 7000);
      }
    },
  });

  const clearArea = h('div', {});
  const askClear = () => clearArea.replaceChildren(
    h('p', {}, 'Delete every imported file, all progress, settings and OPDS sources on this device?'),
    h('button', { class: 'btn danger', onClick: async () => { await db.clearAll(); toast('All data cleared.'); reload(); } }, 'Delete everything'),
    h('button', { class: 'btn', onClick: () => clearArea.replaceChildren(clearBtn) }, 'Cancel'));
  const clearBtn = h('button', { class: 'btn danger', onClick: askClear }, 'Clear all data…');
  clearArea.append(clearBtn);

  view.replaceChildren(
    h('header', { class: 'page-head' }, h('h1', {}, 'Settings')),
    h('section', {}, h('h2', {}, 'Default reading mode'), modeRow('comic', 'Comics'), modeRow('manga', 'Manga')),
    catalogs,
    h('section', {}, h('h2', {}, 'OPDS catalogs'),
      h('p', { class: 'muted' }, 'Add a Komga, Kavita or Calibre-Web catalog. The server must send CORS headers allowing this site’s origin (and the Authorization header if you use a login), or the browser will block requests.'),
      h('ul', { class: 'links' }, sources.map((s) => h('li', { class: 'source' },
        h('a', { href: `#/opds/${s.id}` }, s.name),
        h('button', { class: 'btn-quiet', onClick: async () => { await db.remove('sources', s.id); reload(); } }, 'Remove')))),
      form),
    h('section', {}, h('h2', {}, 'Storage'), storage),
    h('section', {}, h('h2', {}, 'Library data'),
      h('p', { class: 'muted' }, 'Export saves titles, progress and settings only, not the files or covers.'),
      h('div', { class: 'import' },
        h('button', { class: 'btn', onClick: exportJson }, 'Export JSON'),
        h('button', { class: 'btn', onClick: () => importJson.click() }, 'Import JSON'), importJson),
      clearArea));
}
