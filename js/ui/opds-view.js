import { h, showError, toast } from './dom.js';
import * as db from '../db.js';
import { fetchFeed, download } from '../sources/opds.js';
import { importFiles } from '../importers.js';
import { card } from './grid.js';
import { pseItem, ensureItem } from '../items.js';

const EXT = { cbz: 'cbz', epub: 'epub', pdf: 'pdf' };

export async function renderOpds(view, sourceId, feedUrl) {
  const source = await db.get('sources', sourceId);
  if (!source) {
    showError(view, 'That OPDS source no longer exists.');
    return;
  }
  const list = h('div', { class: 'grid' });
  const navList = h('ul', { class: 'links' });
  const status = h('div', { class: 'status' });
  const more = h('button', { class: 'btn', hidden: true });
  view.replaceChildren(
    h('header', { class: 'page-head' }, h('a', { href: '#/settings', class: 'back' }, '‹ Settings'), h('h1', {}, source.name)),
    h('p', { class: 'muted' }, 'The server must allow CORS requests from this site’s origin.'),
    navList, list, status, more);

  async function save(entry, acq) {
    toast(`Downloading ${entry.title}…`);
    try {
      const blob = await download(acq.href, source);
      const file = new File([blob], `${entry.title}.${EXT[acq.format]}`, { type: blob.type });
      const { added, errors } = await importFiles([file], 'auto');
      errors.forEach((e) => toast(e, 7000));
      if (added.length) toast(`Added ${entry.title} to your library`);
    } catch (e) {
      toast(`Download failed: ${e.message}`, 7000);
    }
  }

  function entryCard(entry) {
    const formats = entry.acquisitions.filter((a) => a.format);
    const onOpen = async () => {
      if (entry.pse) {
        const item = await ensureItem(pseItem(entry, sourceId));
        location.hash = `#/read/${encodeURIComponent(item.id)}`;
      } else if (formats.length) {
        await save(entry, formats[0]);
      } else {
        toast('This entry has no supported format (CBZ, EPUB or PDF).');
      }
    };
    return card({
      title: entry.title,
      sub: entry.pse ? 'Stream' : formats[0] ? `Download ${formats[0].format.toUpperCase()}` : entry.author,
      src: entry.thumb,
      onOpen,
    });
  }

  async function load(url) {
    status.textContent = 'Loading…';
    more.hidden = true;
    try {
      const feed = await fetchFeed(url, source);
      for (const e of feed.entries) {
        if (e.nav && !e.acquisitions.length && !e.pse) {
          navList.append(h('li', {}, h('a', { href: `#/opds/${sourceId}?u=${encodeURIComponent(e.nav)}` }, e.title)));
        } else {
          list.append(entryCard(e));
        }
      }
      status.textContent = feed.entries.length ? '' : 'This feed is empty.';
      if (feed.next) {
        more.hidden = false;
        more.textContent = 'Load more';
        more.onclick = () => load(feed.next);
      }
    } catch (e) {
      showError(status, `Could not load the catalog: ${e.message}. Check the URL, credentials and the server’s CORS settings.`, () => load(url));
    }
  }
  await load(feedUrl || source.url);
}
