import { h, sheet } from './dom.js';
import * as db from '../db.js';
import { removeItem } from '../items.js';

const MODES = [['ltr', 'Left to right'], ['rtl', 'Right to left'], ['vertical', 'Vertical scroll']];

// Long-press / "…" menu: mark read, reading direction, delete (with in-page confirm).
export function openItemMenu(item, onChange) {
  let close;
  const done = () => { close(); onChange(); };
  const act = (fn) => async () => { await fn(); done(); };
  const body = h('div', { class: 'menu' });

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
      h('button', { class: 'btn danger', onClick: showConfirm }, 'Delete…'));
  };
  const showConfirm = () => body.replaceChildren(
    h('p', {}, `Delete "${item.title}" from this device? Reading progress is lost.`),
    h('button', { class: 'btn danger', onClick: act(() => removeItem(item.id)) }, 'Delete'),
    h('button', { class: 'btn', onClick: showMain }, 'Cancel'));

  showMain();
  close = sheet(item.title, body);
}
