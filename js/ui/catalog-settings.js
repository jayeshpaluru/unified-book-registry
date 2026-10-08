import { h, toast } from './dom.js';
import * as db from '../db.js';
import { DEFAULT_CATALOG_URL, validateCatalogUrl } from '../sources/catalog-api.js';
import * as anna from '../sources/anna.js';

export async function catalogSettings() {
  const url = h('input', { type: 'url', value: await db.getSetting('catalogUrl', DEFAULT_CATALOG_URL), required: true,
    autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Catalog service URL' });
  const state = h('p', { class: 'muted', role: 'status' }, 'Checking catalog connection…');
  const importState = h('p', { class: 'muted', role: 'status' });
  let busy = false;
  async function check() {
    try {
      const status = await anna.status();
      state.textContent = `Connected · ${status.annaRecords.toLocaleString()} Anna’s Archive records${status.importing ? ' · import running' : ''}.`;
    } catch { state.textContent = 'Disconnected. Start your catalog service, then save its URL here.'; }
  }
  const connect = h('form', { onSubmit: async (event) => {
    event.preventDefault();
    try {
      await db.setSetting('catalogUrl', validateCatalogUrl(url.value.trim()));
      state.textContent = 'Checking connection…';
      await check();
    } catch (error) { toast(error.message); }
  } }, h('label', { class: 'field' }, h('span', {}, 'Catalog service URL'), url),
  h('button', { class: 'btn', type: 'submit' }, 'Save and check connection'));

  const file = h('input', { type: 'file', multiple: true, hidden: true, accept: '.json,.jsonl,.ndjson,.gz,.zst', onChange: async (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    if (busy || !files.length) return;
    busy = true; importButton.disabled = true;
    try {
      let imported = 0, skipped = 0;
      for (const metadata of files) {
        importState.textContent = `Importing ${metadata.name}… Keep the catalog service running.`;
        const result = await anna.importMetadata(metadata);
        imported += result.imported; skipped += result.skipped;
      }
      importState.textContent = `${imported.toLocaleString()} records imported${skipped ? `; ${skipped.toLocaleString()} unsupported records skipped` : ''}.`;
      await check();
    } catch (error) { importState.textContent = error.message; }
    finally { busy = false; importButton.disabled = false; }
  } });
  const importButton = h('button', { class: 'btn', onClick: () => file.click() }, 'Import Anna’s Archive metadata');
  const lang = h('input', { value: await db.getSetting('mangaLanguage', 'en'), placeholder: 'en',
    autocapitalize: 'off', autocomplete: 'off', pattern: '[a-z]{2}(-[a-z]{2})?', 'aria-label': 'Preferred translation language' });
  lang.addEventListener('change', () => {
    if (!lang.checkValidity()) { lang.reportValidity(); return; }
    db.setSetting('mangaLanguage', lang.value || 'en');
  });
  const section = h('section', {}, h('h2', {}, 'Books, comics and scanlation catalogs'),
    h('p', { class: 'muted' }, 'The catalog service connects Anna’s Archive metadata, MangaDex chapters and MangaUpdates releases.'),
    connect, state,
    h('div', { class: 'import' }, importButton, file), importState,
    h('p', { class: 'muted' }, 'Choose a combined Anna’s Archive JSON/JSONL export, including .gz or .zst files. Metadata stays in your local catalog database.'),
    h('a', { href: 'https://annas-archive.pk/datasets', target: '_blank', rel: 'noopener noreferrer' }, 'Anna’s Archive metadata sources ↗'),
    h('label', { class: 'field' }, h('span', {}, 'Preferred MangaDex translation language (e.g. en, es, pt-br)'), lang));
  check();
  return section;
}
