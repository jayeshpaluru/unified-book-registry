import { h } from './dom.js';
import { mountBrowse } from './browse.js';
import { card } from './grid.js';
import * as archive from '../sources/archive.js';
import * as gutendex from '../sources/gutendex.js';
import { iaItem, ensureItem } from '../items.js';
import { renderLibrary } from './library.js';
import { mountSourceTabs, mountCatalogBrowse } from './catalog-view.js';

function renderArchiveComics(view) {
  return mountBrowse(view, {
    title: 'Comics',
    intro: 'Public-domain Golden Age comics from the Internet Archive. Opening one adds it to your library.',
    placeholder: 'Search titles (e.g. captain marvel)',
    fetchPage: async (text, page = 1) => {
      const r = await archive.search(text, page);
      return { items: r.items, next: r.hasMore ? page + 1 : null };
    },
    renderCard: (entry) => card({
      title: entry.title,
      sub: entry.year,
      src: entry.cover,
      onOpen: async () => {
        const item = await ensureItem(iaItem(entry));
        location.hash = `#/read/${encodeURIComponent(item.id)}`;
      },
    }),
  });
}

function bookSheetBody(book) {
  return h('div', { class: 'menu' },
    h('p', {}, book.author),
    h('p', { class: 'muted' }, 'Gutenberg does not allow browsers on other sites to download its files, so books open on gutenberg.org. To read one here, download the EPUB and use Import in the Library.'),
    h('a', { class: 'btn', href: book.readUrl, target: '_blank', rel: 'noopener' }, 'Open on Gutenberg ↗'),
    book.epubUrl && h('a', { class: 'btn', href: book.epubUrl, target: '_blank', rel: 'noopener' }, 'Download EPUB ↗'));
}

function renderGutenberg(view, openSheet) {
  return mountBrowse(view, {
    title: 'Books',
    intro: 'Public-domain books from Project Gutenberg.',
    placeholder: 'Search title or author',
    fetchPage: async (text, next) => {
      const r = await gutendex.search(text, next);
      return { items: r.items, next: r.next };
    },
    renderCard: (book) => card({
      title: book.title,
      sub: book.author,
      src: book.cover,
      onOpen: () => openSheet(book.title, bookSheetBody(book)),
    }),
  });
}

const OFFICIAL = [
  ['MANGA Plus by Shueisha', 'https://mangaplus.shueisha.co.jp/'],
  ['Shonen Jump', 'https://www.viz.com/shonenjump'],
  ['Webtoon', 'https://www.webtoons.com/'],
  ['Comikey', 'https://comikey.com/'],
];

async function renderLocalManga(view) {
  await renderLibrary(view, { fixedType: 'manga' });
  view.append(
    h('section', { class: 'official' },
      h('h2', {}, 'Official free readers'),
      h('p', { class: 'muted' }, 'Read on the publishers’ sites.'),
      h('ul', { class: 'links' }, OFFICIAL.map(([name, href]) =>
        h('li', {}, h('a', { href, target: '_blank', rel: 'noopener' }, `${name} ↗`))))));
}

export function renderBooks(view, openSheet) {
  return mountSourceTabs(view, {
    anna: { name: 'Anna’s Archive', mount: (host) => mountCatalogBrowse(host, 'anna', { title: 'Books', type: 'book' }) },
    gutenberg: { name: 'Gutenberg', mount: (host) => renderGutenberg(host, openSheet) },
    local: { name: 'Your books', mount: (host) => renderLibrary(host, { fixedType: 'book' }) },
  }, 'anna', 'booksCatalog');
}

export function renderComics(view) {
  return mountSourceTabs(view, {
    anna: { name: 'Anna’s Archive', mount: (host) => mountCatalogBrowse(host, 'anna', { title: 'Comics', type: 'comic' }) },
    archive: { name: 'Internet Archive', mount: renderArchiveComics },
    local: { name: 'Your comics', mount: (host) => renderLibrary(host, { fixedType: 'comic' }) },
  }, 'anna', 'comicsCatalog');
}

export function renderManga(view) {
  return mountSourceTabs(view, {
    mangadex: { name: 'MangaDex', mount: (host) => mountCatalogBrowse(host, 'mangadex', { title: 'Manga' }) },
    mangaupdates: { name: 'MangaUpdates', mount: (host) => mountCatalogBrowse(host, 'mangaupdates', { title: 'Manga' }) },
    local: { name: 'Your manga', mount: renderLocalManga },
  }, 'mangadex', 'mangaCatalog');
}
