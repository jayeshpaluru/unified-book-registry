import { h } from './dom.js';
import { mountBrowse } from './browse.js';
import { card } from './grid.js';
import * as archive from '../sources/archive.js';
import * as gutendex from '../sources/gutendex.js';
import { iaItem, ensureItem } from '../items.js';
import { renderLibrary } from './library.js';
import { mountSourceTabs, mountCatalogBrowse } from './catalog-view.js';
import { mountTorboxBrowse } from './torbox-view.js';
import { sourceLink } from './links.js';

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
    h('p', { class: 'muted' }, 'This is a catalog entry. Import an EPUB into your Library or connect a matching TorBox file to read it here. Some Gutenberg file hosts do not allow in-app browser downloads.'),
    book.epubUrl && sourceLink('Download EPUB here', book.epubUrl, 'btn', `${book.title}.epub`));
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

async function renderLocalManga(view) {
  await renderLibrary(view, { fixedType: 'manga' });
}

export function renderBooks(view, openSheet) {
  return mountSourceTabs(view, {
    anna: { name: 'Anna’s Archive', mount: (host) => mountCatalogBrowse(host, 'anna', { title: 'Books', type: 'book' }) },
    gutenberg: { name: 'Gutenberg', mount: (host) => renderGutenberg(host, openSheet) },
    torbox: { name: 'TorBox', mount: (host) => mountTorboxBrowse(host, 'book') },
    local: { name: 'Your books', mount: (host) => renderLibrary(host, { fixedType: 'book' }) },
  }, 'anna', 'booksCatalog');
}

export function renderComics(view) {
  return mountSourceTabs(view, {
    anna: { name: 'Anna’s Archive', mount: (host) => mountCatalogBrowse(host, 'anna', { title: 'Comics', type: 'comic' }) },
    archive: { name: 'Internet Archive', mount: renderArchiveComics },
    getcomics: { name: 'GetComics', mount: (host) => mountCatalogBrowse(host, 'getcomics', { title: 'Comics' }) },
    torbox: { name: 'TorBox', mount: (host) => mountTorboxBrowse(host, 'comic') },
    local: { name: 'Your comics', mount: (host) => renderLibrary(host, { fixedType: 'comic' }) },
  }, 'anna', 'comicsCatalog');
}

export function renderManga(view) {
  return mountSourceTabs(view, {
    mangapill: { name: 'MangaPill', mount: (host) => mountCatalogBrowse(host, 'mangapill', { title: 'Manga' }) },
    weebcentral: { name: 'Weeb Central', mount: (host) => mountCatalogBrowse(host, 'weebcentral', { title: 'Manga' }) },
    anna: { name: 'Anna’s Archive', mount: (host) => mountCatalogBrowse(host, 'anna', { title: 'Manga and comics', type: 'comic' }) },
    mangadex: { name: 'MangaDex', mount: (host) => mountCatalogBrowse(host, 'mangadex', { title: 'Manga' }) },
    mangaupdates: { name: 'MangaUpdates', mount: (host) => mountCatalogBrowse(host, 'mangaupdates', { title: 'Manga' }) },
    comikey: { name: 'Comikey', mount: (host) => mountCatalogBrowse(host, 'comikey', { title: 'Manga' }) },
    webtoon: { name: 'WEBTOON', mount: (host) => mountCatalogBrowse(host, 'webtoon', { title: 'Manga' }) },
    torbox: { name: 'TorBox', mount: (host) => mountTorboxBrowse(host, 'manga') },
    local: { name: 'Your manga', mount: renderLocalManga },
  }, 'mangadex', 'mangaCatalog');
}
