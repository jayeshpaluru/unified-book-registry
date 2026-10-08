import { h, toast } from './dom.js';
import * as db from '../db.js';
import { importFiles, filesFromDrop } from '../importers.js';
import { libraryCard } from './grid.js';
import { openItemMenu } from './item-menu.js';

const FILTERS = [['all', 'All'], ['comic', 'Comics'], ['manga', 'Manga'], ['book', 'Books']];
const ACCEPT = '.cbz,.zip,.epub,.pdf,.txt,.html,.htm,.cbr,.rar,image/*';

const open = (item) => { location.hash = `#/read/${encodeURIComponent(item.id)}`; };

// Importing UI shared by the Library and Manga tabs.
export function importControls(onDone, defaultType = 'auto') {
  const select = h('select', { 'aria-label': 'Import as' },
    [['auto', 'Auto'], ['comic', 'Comic'], ['manga', 'Manga (RTL)'], ['book', 'Book']].map(([v, t]) =>
      h('option', { value: v, selected: v === defaultType }, t)));
  const run = async (files) => {
    if (!files.length) return;
    navigator.storage?.persist?.();
    toast(`Importing ${files.length} file${files.length > 1 ? 's' : ''}…`);
    const { added, errors } = await importFiles(files, select.value);
    if (added.length) toast(`Added ${added.map((i) => i.title).join(', ')}`);
    errors.forEach((e) => toast(e, 7000));
    onDone();
  };
  const picker = (extra) => h('input', { type: 'file', multiple: true, accept: ACCEPT, hidden: true, ...extra,
    onChange: (e) => { run([...e.target.files]); e.target.value = ''; } });
  const files = picker();
  const folder = picker({ webkitdirectory: true });
  const node = h('div', { class: 'import' },
    h('button', { class: 'btn', onClick: () => files.click() }, 'Import files'),
    h('button', { class: 'btn', onClick: () => folder.click() }, 'Folder'),
    select, files, folder);
  return { node, run };
}

export async function renderLibrary(view, { fixedType } = {}) {
  let filter = fixedType || 'all';
  const grid = h('div', { class: 'grid' });
  const continueRow = h('section', { class: 'continue' });
  const chips = h('nav', { class: 'chips' });
  const imp = importControls(refresh, fixedType || 'auto');

  view.replaceChildren(
    h('header', { class: 'page-head' }, h('h1', {}, fixedType ? `Your ${fixedType === 'comic' ? 'comics' : fixedType === 'book' ? 'books' : 'manga'}` : 'Library'), imp.node),
    continueRow, !fixedType && chips, grid,
    h('p', { class: 'muted drop-hint' }, 'Drop CBZ, ZIP, EPUB, PDF or images anywhere on this page.'));

  const onDragOver = (e) => { e.preventDefault(); view.classList.add('dragging'); };
  view.ondragover = onDragOver;
  view.ondragleave = () => view.classList.remove('dragging');
  view.ondrop = async (e) => {
    e.preventDefault();
    view.classList.remove('dragging');
    imp.run(await filesFromDrop(e.dataTransfer));
  };

  async function refresh() {
    const items = (await db.allItems()).sort((a, b) => b.addedAt - a.addedAt);
    const shown = items.filter((i) => filter === 'all' || i.type === filter);
    const cardFor = (i) => libraryCard(i, { onOpen: open, onMenu: (it) => openItemMenu(it, refresh) });

    const recent = items
      .filter((i) => i.lastRead && !i.read && (!fixedType || i.type === fixedType))
      .sort((a, b) => b.lastRead - a.lastRead).slice(0, 12);
    continueRow.replaceChildren(...(recent.length
      ? [h('h2', {}, 'Continue reading'), h('div', { class: 'row' }, recent.map(cardFor))] : []));

    chips.replaceChildren(...FILTERS.map(([value, text]) => h('button', {
      class: `chip${filter === value ? ' on' : ''}`,
      onClick: () => { filter = value; refresh(); },
    }, text)));

    grid.replaceChildren(...(shown.length ? shown.map(cardFor)
      : [h('p', { class: 'muted empty' }, items.length ? 'Nothing here yet.' : 'Your library is empty. Import files above, or browse Comics and Books.')]));
  }
  await refresh();
}
