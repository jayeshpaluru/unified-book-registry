import { h } from './dom.js';
import { coverSrc } from '../items.js';

const LONG_PRESS_MS = 500;

// One cover card. opts: { title, sub, src, pct, onOpen, onMenu }
export function card({ title, sub, src, pct, onOpen, onMenu }) {
  let timer;
  let suppressClick = false;
  const cancel = () => clearTimeout(timer);
  const fire = () => { suppressClick = true; onMenu(); };

  const cover = h('div', { class: 'cover' },
    src ? h('img', { src, alt: '', loading: 'lazy', decoding: 'async' }) : h('span', { class: 'cover-title' }, title),
    pct > 0 && h('div', { class: 'bar' }, h('i', { style: `width:${Math.round(pct * 100)}%` })));

  const main = h('button', {
    class: 'card-main',
    onClick: () => (suppressClick ? (suppressClick = false) : onOpen()),
    onPointerdown: onMenu && (() => { suppressClick = false; timer = setTimeout(fire, LONG_PRESS_MS); }),
    onPointerup: cancel,
    onPointerleave: cancel,
    onPointercancel: cancel,
    onPointermove: cancel,
    onContextmenu: (e) => { e.preventDefault(); },
  }, cover, h('span', { class: 'card-title' }, title), sub && h('span', { class: 'card-sub' }, sub));

  return h('div', { class: 'card' }, main,
    onMenu && h('button', { class: 'card-more', 'aria-label': `Options for ${title}`, onClick: onMenu }, '…'));
}

export function libraryCard(item, { onOpen, onMenu }) {
  return card({
    title: item.title,
    sub: [{ comic: 'Comic', manga: 'Manga', book: 'Book' }[item.type], item.sourceName].filter(Boolean).join(' · '),
    src: coverSrc(item),
    pct: item.read ? 1 : item.progress?.pct,
    onOpen: () => onOpen(item),
    onMenu: () => onMenu(item),
  });
}
