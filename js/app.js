// Hash router + shell wiring.
import { h, sheet } from './ui/dom.js';
import { renderLibrary } from './ui/library.js';
import { renderComics, renderBooks, renderManga } from './ui/tabs.js';
import { renderSettings } from './ui/settings.js';
import { renderOpds } from './ui/opds-view.js';
import { openReader } from './ui/reader-view.js';

const view = document.getElementById('view');
const readerHost = document.getElementById('reader');
const tabs = [...document.querySelectorAll('#tabbar a')];

let teardown = null;
let reader = null;
let routeId = 0;
let routed = false; // true once we've navigated inside the app (so back() is safe)

const TABS = {
  library: (v) => renderLibrary(v),
  comics: (v) => renderComics(v),
  books: (v) => renderBooks(v, sheet),
  manga: (v) => renderManga(v),
  settings: (v) => renderSettings(v),
};

function closeReader() {
  if (routed && history.length > 1) history.back();
  else location.hash = '#/library';
}

async function route() {
  const mine = ++routeId;
  const [path, query = ''] = (location.hash.slice(2) || 'library').split('?');
  const [name, arg] = path.split('/');

  // A file picker may be nested inside a catalog sheet. Navigation must close
  // both layers so no catalog dialog remains over the native reader.
  document.querySelectorAll('.sheet-backdrop').forEach((element) => element.remove());

  teardown?.();
  teardown = null;
  reader?.destroy();
  reader = null;

  const reading = name === 'read';
  document.body.classList.toggle('reading', reading);
  readerHost.hidden = !reading;
  if (reading) {
    const opened = await openReader(readerHost, decodeURIComponent(arg), closeReader);
    if (mine === routeId) reader = opened; else opened.destroy();
    return;
  }

  tabs.forEach((a) => a.classList.toggle('on', a.dataset.tab === (name === 'opds' ? 'settings' : name)));
  window.scrollTo(0, 0);
  if (name === 'opds') {
    await renderOpds(view, arg, new URLSearchParams(query).get('u'));
  } else {
    const fn = TABS[name] || TABS.library;
    const result = await fn(view);
    if (mine === routeId && typeof result === 'function') teardown = result;
  }
}

window.addEventListener('hashchange', () => { routed = true; route(); });
route();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => view.prepend(h('p', { class: 'muted' }, `Offline support unavailable: ${e.message}`)));
}
navigator.storage?.persist?.();
