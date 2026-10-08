import { h, sheet, toast, showError } from './dom.js';
import { mountBrowse } from './browse.js';
import { card } from './grid.js';
import { ensureItem, catalogItem, chapterItem } from '../items.js';
import * as db from '../db.js';
import * as anna from '../sources/anna.js';
import * as mangadex from '../sources/mangadex.js';
import * as mangaupdates from '../sources/mangaupdates.js';
import * as publishers from '../sources/publishers.js';
import { catalogMode, catalogRequest } from '../sources/catalog-api.js';
import { hasGithubSession } from '../sources/github-jobs.js';
import { sourceLink } from './links.js';
import { chapterCbz, safeFilename, saveBlob } from '../downloads.js';
import { annaDownloadOptions } from './anna-downloads.js';
export { sourceLink } from './links.js';

export function mountSourceTabs(view, sources, initial, preferenceKey) {
  let teardown, generation = 0;
  const nav = h('nav', { class: 'chips catalog-tabs', 'aria-label': 'Catalog sources' });
  const content = h('div', {});
  view.replaceChildren(nav, content);
  const pick = async (id) => {
    const mine = ++generation;
    teardown?.(); teardown = null;
    nav.querySelectorAll('button').forEach((button) => {
      button.classList.toggle('on', button.dataset.source === id);
      button.setAttribute('aria-pressed', button.dataset.source === id);
    });
    const section = h('section', {});
    content.replaceChildren(section);
    try {
      const cleanup = await sources[id].mount(section);
      if (mine === generation) teardown = cleanup;
      else if (typeof cleanup === 'function') cleanup();
    } catch (error) {
      if (mine === generation) showError(section, error.message, () => pick(id));
    }
  };
  for (const [id, source] of Object.entries(sources)) nav.append(h('button', {
    class: 'chip', dataset: { source: id }, onClick: () => {
      if (preferenceKey) db.setSetting(preferenceKey, id).catch((error) => toast(error.message));
      pick(id);
    },
  }, source.name));
  if (preferenceKey) db.getSetting(preferenceKey, initial).then((saved) => {
    if (generation === 0) pick(sources[saved] ? saved : initial);
  });
  else pick(initial);
  return () => { generation++; if (typeof teardown === 'function') teardown(); };
}

const chapterLabel = (entry) => [entry.volume && `Vol. ${entry.volume}`,
  entry.chapter != null && entry.chapter !== '' ? `Ch. ${entry.chapter}` : entry.title || 'Oneshot'].filter(Boolean).join(' · ');
const groupLinks = (groups) => groups.length ? groups.map((group, index) => [
  index > 0 && ', ', sourceLink(group.name, group.url, 'credit-link') || group.name,
]).flat() : ['No group credited by the source'];

function catalogDetails(entry) {
  const metadata = [entry.author, entry.year, entry.publisher, entry.extension?.toUpperCase(), entry.languages?.join(', ')].filter(Boolean).join(' · ');
  const saveButton = h('button', { class: 'btn', onClick: async () => {
    try {
      await ensureItem(catalogItem(entry));
      saveButton.textContent = 'Saved to library';
      toast('Saved to your library.');
    } catch (error) { toast(error.message); }
  } }, 'Save to library');
  return h('div', { class: 'menu' },
    h('p', { class: 'muted' }, entry.sourceName), metadata && h('p', {}, metadata),
    entry.summary && h('p', { class: 'catalog-summary' }, entry.summary.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')),
    entry.isbn?.length && h('p', { class: 'muted' }, `ISBN: ${entry.isbn.join(', ')}`),
    sourceLink(`Open on ${entry.sourceName} ↗`, entry.readUrl), saveButton,
    entry.source === 'anna' && h('p', { class: 'muted' }, 'This saves the catalog entry. Import a book or comic file into your Library to read it here.'),
    entry.source === 'mangaupdates' && h('p', { class: 'muted' }, 'MangaUpdates tracks releases and scanlation groups. Chapter reading is available through MangaDex or imported files.'));
}

function mangaDexChapters(entry, host) {
  let cursor = 0, loading = false, generation = 0;
  const list = h('ul', { class: 'links chapter-list' });
  const status = h('div', { class: 'status' });
  const more = h('button', { class: 'btn', onClick: () => load() }, 'More chapters');
  const select = h('select', { 'aria-label': 'Chapter translation language' },
    [...new Set(['en', ...(entry.languages || [])])].sort().map((code) => h('option', { value: code }, code)));
  host.append(h('h2', {}, 'Chapters'), h('label', { class: 'field' }, h('span', {}, 'Translation language'), select), list, status, more);
  select.addEventListener('change', () => {
    db.setSetting('mangaLanguage', select.value);
    generation++; cursor = 0; loading = false; list.replaceChildren(); load();
  });
  async function load() {
    if (loading || cursor === null) return;
    loading = true;
    const mine = generation;
    more.hidden = true; status.textContent = 'Loading chapters…';
    try {
      const page = await mangadex.chapters(entry.id, cursor, select.value);
      if (mine !== generation || !host.isConnected) return;
      for (const chapter of page.items) {
        const read = h('button', { class: 'btn', onClick: async () => {
          try {
            const item = await ensureItem(chapterItem(entry, chapter));
            host.closest('.sheet-backdrop')?.remove();
            location.hash = `#/read/${encodeURIComponent(item.id)}`;
          } catch (error) { toast(error.message); }
        } }, 'Read here');
        const downloadStatus = h('p', { class: 'muted', role: 'status' });
        let controller;
        const cancel = h('button', { class: 'btn', hidden: true, onClick: () => controller?.abort() }, 'Cancel download');
        const download = h('button', { class: 'btn', onClick: async () => {
          download.disabled = true; cancel.hidden = false; controller = new AbortController();
          downloadStatus.textContent = 'Loading chapter pages…';
          try {
            const blob = await chapterCbz(await mangadex.loadPages(chapter.id), { title: `${entry.title} · ${chapterLabel(chapter)}`,
              credits: `MangaDex; scanlation: ${chapter.groups.map((group) => group.name).join(', ')}`, signal: controller.signal,
              onProgress: ({ pages, totalPages }) => { downloadStatus.textContent = `Downloading page ${pages}/${totalPages}…`; } });
            saveBlob(blob, safeFilename(`${entry.title} ${chapterLabel(chapter)}`, 'cbz')); downloadStatus.textContent = 'CBZ download started.';
          } catch (error) { downloadStatus.textContent = controller.signal.aborted ? 'Download cancelled.' : error instanceof TypeError
            ? 'The image server blocked browser download. Use the provider reader instead.' : error.message; }
          finally { download.disabled = false; cancel.hidden = true; }
        } }, 'Download CBZ');
        list.append(h('li', {},
          h('strong', {}, chapterLabel(chapter)), chapter.title && h('p', {}, chapter.title),
          h('p', { class: 'muted' }, 'Scanlation: ', groupLinks(chapter.groups)),
          h('div', { class: 'import' }, chapter.externalUrl ? sourceLink('Open chapter ↗', chapter.externalUrl) : read,
            !chapter.externalUrl && download, cancel, sourceLink('MangaDex ↗', chapter.readUrl)), downloadStatus));
      }
      cursor = page.next;
      status.textContent = list.children.length ? '' : 'No available chapters in this language.';
      more.hidden = cursor === null;
    } catch (error) {
      if (mine === generation && host.isConnected) showError(status, error.message, () => load());
    } finally { if (mine === generation) loading = false; }
  }
  db.getSetting('mangaLanguage', 'en').then((code) => {
    if ([...select.options].some((option) => option.value === code)) select.value = code;
    load();
  });
}

function mangaUpdatesReleases(entry, host) {
  let cursor = 1, loading = false;
  const list = h('ul', { class: 'links chapter-list' });
  const status = h('div', { class: 'status' });
  const more = h('button', { class: 'btn', onClick: () => load() }, 'More releases');
  host.append(h('h2', {}, 'Scanlation releases'), list, status, more);
  async function load() {
    if (loading || cursor === null) return;
    loading = true; more.hidden = true; status.textContent = 'Loading releases…';
    try {
      const page = await mangaupdates.releases(entry.id, cursor);
      if (!host.isConnected) return;
      for (const release of page.items) list.append(h('li', {},
        h('strong', {}, chapterLabel(release)), h('p', { class: 'muted' }, release.date || ''),
        h('p', {}, groupLinks(release.groups))));
      cursor = page.next;
      status.textContent = list.children.length ? '' : 'No releases found.';
      more.hidden = cursor === null;
    } catch (error) { if (host.isConnected) showError(status, error.message, () => load()); }
    finally { loading = false; }
  }
  load();
}

export function catalogBody(entry) {
  const body = catalogDetails(entry);
  if (entry.source === 'anna') body.append(annaDownloadOptions(entry));
  if (entry.source === 'mangadex') mangaDexChapters(entry, body);
  if (entry.source === 'mangaupdates') mangaUpdatesReleases(entry, body);
  return body;
}

export const openCatalogEntry = (entry) => sheet(entry.title, catalogBody(entry));

export function mountCatalogBrowse(view, provider, { title, type } = {}) {
  const sources = { anna, mangadex, mangaupdates };
  const names = { anna: 'Anna’s Archive', mangadex: 'MangaDex', mangaupdates: 'MangaUpdates', comikey: 'Comikey', webtoon: 'WEBTOON' };
  const intro = {
    anna: 'Search imported shadow-library metadata by title, author or ISBN. This is a metadata catalog; book files are not bundled. Import combined aarecord data in Settings.',
    mangadex: 'Browse MangaDex manga and scanlations. Open a series to choose a chapter and translation language.',
    mangaupdates: 'Find manga, manhwa and manhua with scanlation releases, credited groups and release dates from MangaUpdates.',
    comikey: 'Browse the official Comikey manga, manhwa and webcomic directory. Free previews and paid chapter unlocks vary by title.',
    webtoon: 'Browse English WEBTOON Originals and open their official episode readers. Some episodes require coins.',
  };
  const cleanup = mountBrowse(view, {
    title: title || names[provider], intro: intro[provider], placeholder: provider === 'anna' ? 'Title, author or ISBN' : 'Search series titles',
    fetchPage: (text, cursor) => provider === 'anna' ? anna.search(text, cursor, type) : sources[provider]
      ? sources[provider].search(text, cursor) : publishers.search(provider, text, cursor),
    renderCard: (entry) => card({ title: entry.title, sub: entry.author || entry.year || entry.sourceName,
      src: entry.cover, onOpen: () => openCatalogEntry(entry) }),
  });
  const note = h('p', { class: 'muted' });
  view.append(note);
  catalogMode().then(async (mode) => {
    if (mode !== 'static') { note.append('Catalog connection and metadata imports: ', h('a', { href: '#/settings' }, 'Settings')); return; }
    try {
      const health = await anna.status();
      const source = health.providers[provider];
      note.append(`${provider === 'anna' && health.remoteAnna ? 'Connected TorBox index' : 'Static catalog'}: ${(source?.records || 0).toLocaleString()} entries. ${source?.coverage || ''} `,
        h('a', { href: '#/settings' }, 'Catalog status / connection'));
      if (provider === 'anna' && !health.annaRecords) note.append(' Anna’s metadata has not been imported yet; this is not the complete shadow-library index.');
    } catch { note.append('Static catalog not yet built. ', h('a', { href: '#/settings' }, 'Settings')); }
  });
  if (['mangadex', 'mangaupdates'].includes(provider)) {
    const status = h('p', { class: 'muted', role: 'status' });
    const live = h('button', { class: 'btn', onClick: async () => {
      if (!hasGithubSession()) { toast('Connect your GitHub Actions session in Settings for live search.'); return; }
      live.disabled = true; status.textContent = 'Searching the full provider catalog via GitHub Actions…';
      try {
        const text = view.querySelector('input[type="search"]')?.value || '';
        const raw = await catalogRequest(`${provider}/search`, { q: text, ...(provider === 'mangadex' ? { offset: 0 } : { page: 1 }) }, { live: true });
        const result = sources[provider].mapSearch(raw);
        const grid = h('div', { class: 'grid' }, result.items.map((entry) => card({ title: entry.title, sub: entry.author || entry.sourceName,
          src: entry.cover, onOpen: () => openCatalogEntry(entry) })));
        status.replaceChildren(h('p', {}, `${result.total.toLocaleString()} matches · showing the first ${result.items.length}.`), grid);
      } catch (error) { status.textContent = error.message; }
      finally { live.disabled = false; }
    } }, 'Search full provider live');
    catalogMode().then((mode) => { if (mode === 'static') view.append(live, status); });
  }
  return cleanup;
}

export function mountCatalogReference(host, item, onClose) {
  const content = h('div', { class: 'catalog-reference' }, h('button', { class: 'btn', onClick: onClose }, 'Back'),
    h('h1', {}, item.title), catalogBody(item.catalogEntry));
  host.replaceChildren(content);
  return { destroy() { content.remove(); } };
}
