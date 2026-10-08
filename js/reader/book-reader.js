// Book reader: EPUB via epub.js (paginated) and plain/HTML text in a scroll container.
import { h } from '../ui/dom.js';
import { clamp } from '../util.js';
import { loadEpubjs } from '../lib.js';
import { getSetting, setSetting } from '../db.js';

const FONTS = {
  serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
  sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
};
export const DEFAULT_PREFS = { font: 'serif', size: 19, lineHeight: 1.6, margin: 24 };
const SWIPE_PX = 50;

const FORBIDDEN = 'script,style,link,iframe,object,embed,img,svg,form,meta,base,template';

// Plain text becomes paragraphs; HTML is stripped of anything active or external.
export function textToNodes(raw, format) {
  const frag = document.createDocumentFragment();
  if (format === 'html') {
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    doc.querySelectorAll(FORBIDDEN).forEach((n) => n.remove());
    doc.querySelectorAll('*').forEach((n) => {
      for (const a of [...n.attributes]) if (!['href', 'id'].includes(a.name)) n.removeAttribute(a.name);
      if (n.tagName !== 'A' || !n.getAttribute('href')?.startsWith('#')) n.removeAttribute('href');
    });
    frag.append(...doc.body.childNodes);
  } else {
    for (const para of raw.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
      if (para.trim()) frag.append(h('p', {}, para.replace(/\n/g, ' ').trim()));
    }
  }
  return frag;
}

// opts: { item, blob, onProgress({pct, cfi}), onClose() }
export async function mountBookReader(host, opts) {
  const { item, blob, onProgress, onClose } = opts;
  const prefs = { ...DEFAULT_PREFS, ...(await getSetting('bookPrefs', {})) };
  let overlayTimer;
  let applyPrefs = () => {};
  const setApply = (f) => { applyPrefs = f; f(); };
  let controller; // { zone(x), scrubTo(pct), destroy() }

  // ---- chrome ---------------------------------------------------------------
  const content = h('div', { class: 'br-content' });
  const slider = h('input', { type: 'range', min: 0, max: 1000, value: Math.round((item.progress?.pct || 0) * 1000), 'aria-label': 'Progress', disabled: true });
  const label = h('span', { class: 'ir-label' }, `${Math.round((item.progress?.pct || 0) * 100)}%`);
  const panel = h('div', { class: 'br-panel', hidden: true });
  const root = h('div', { class: 'br' },
    content,
    h('header', { class: 'ir-bar ir-top' },
      h('button', { class: 'btn-quiet', onClick: close }, 'Close'),
      h('span', { class: 'ir-title' }, item.title),
      h('button', { class: 'btn-quiet', onClick: () => { panel.hidden = !panel.hidden; setOverlay(true); } }, 'Aa')),
    panel,
    h('footer', { class: 'ir-bar ir-bottom' }, slider, label));
  host.replaceChildren(root);

  function setOverlay(show) {
    clearTimeout(overlayTimer);
    root.classList.toggle('show-bars', show);
    if (!show) panel.hidden = true;
    else overlayTimer = setTimeout(() => setOverlay(false), panel.hidden ? 3500 : 8000);
  }
  const toggleOverlay = () => setOverlay(!root.classList.contains('show-bars'));

  function stepper(name, text, key, step, lo, hi, digits = 0) {
    const bump = (d) => {
      prefs[key] = Number(clamp(prefs[key] + d * step, lo, hi).toFixed(digits));
      change();
    };
    return h('div', { class: 'br-row' }, h('span', {}, text),
      h('button', { class: 'btn', onClick: () => bump(-1), 'aria-label': `${name} smaller` }, '−'),
      h('button', { class: 'btn', onClick: () => bump(1), 'aria-label': `${name} larger` }, '+'));
  }
  function change() {
    setSetting('bookPrefs', prefs);
    applyPrefs();
    setOverlay(true);
  }
  panel.append(
    stepper('Text size', 'Size', 'size', 1, 12, 32),
    stepper('Line height', 'Line height', 'lineHeight', 0.1, 1.2, 2.2, 1),
    stepper('Margins', 'Margins', 'margin', 4, 0, 64),
    h('div', { class: 'br-row' }, h('span', {}, 'Font'),
      h('button', { class: 'btn', onClick: () => { prefs.font = 'serif'; change(); } }, 'Serif'),
      h('button', { class: 'btn', onClick: () => { prefs.font = 'sans'; change(); } }, 'Sans')));

  function zone(x) {
    const third = innerWidth / 3;
    if (!controller) return;
    if (x < third) controller.step(-1);
    else if (x > 2 * third) controller.step(1);
    else toggleOverlay();
  }

  function report(pct, extra = {}) {
    slider.value = Math.round(pct * 1000);
    label.textContent = `${Math.round(pct * 100)}%`;
    onProgress({ pct, ...extra });
  }

  slider.addEventListener('change', () => { controller?.scrubTo(slider.value / 1000); setOverlay(true); });
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') controller?.step(-1);
    else if (e.key === 'ArrowRight' || e.key === ' ') controller?.step(1);
  };
  document.addEventListener('keydown', onKey);

  function cleanup() {
    clearTimeout(overlayTimer);
    document.removeEventListener('keydown', onKey);
    controller?.destroy();
    controller = null;
    host.replaceChildren();
  }

  function close() {
    cleanup();
    onClose();
  }

  try {
    controller = item.format === 'epub'
      ? await mountEpub(content, { item, blob, prefs, zone, report, setApply, slider })
      : await mountText(content, { item, blob, prefs, zone, report, setApply, slider });
  } catch (e) {
    content.replaceChildren(h('div', { class: 'notice' }, h('p', {}, `Could not open this book: ${e.message}`)));
  }
  setOverlay(true);
  return { destroy: cleanup };
}

// ---- EPUB ---------------------------------------------------------------------
async function mountEpub(content, { item, blob, prefs, zone, report, setApply, slider }) {
  const ePub = await loadEpubjs();
  const book = ePub(await blob.arrayBuffer());
  const pageEl = h('div', { class: 'br-epub' });
  content.replaceChildren(h('div', { class: 'br-epub' }, pageEl));
  const rendition = book.renderTo(pageEl, { width: '100%', height: '100%', flow: 'paginated', spread: 'none',
    allowScriptedContent: false, allowPopups: false });
  let locationsReady = false;
  let swipedAt = 0;
  let shown = false;

  const text = {
    'p, li, span, div, h1, h2, h3, h4, h5, h6, td, blockquote': { color: '#fff !important' },
    a: { color: '#9bb8ff !important' },
    img: { 'max-width': '100% !important' },
  };
  rendition.themes.default(text);
  setApply(() => {
    document.documentElement.style.setProperty('--book-margin', `${prefs.margin}px`);
    const t = rendition.themes;
    t.override('background', '#000', true);
    t.override('color', '#fff', true);
    t.override('font-family', FONTS[prefs.font], true);
    t.override('line-height', String(prefs.lineHeight), true);
    t.fontSize(`${prefs.size}px`);
    if (shown) rendition.resize();
  });

  rendition.hooks.content.register((contents) => {
    const doc = contents.document;
    let start;
    doc.addEventListener('touchstart', (e) => { const t = e.changedTouches[0]; start = { x: t.screenX, y: t.screenY }; }, { passive: true });
    doc.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      const dx = t.screenX - start.x, dy = t.screenY - start.y;
      if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > 1.5 * Math.abs(dy)) {
        swipedAt = Date.now();
        dx < 0 ? rendition.next() : rendition.prev();
      }
    }, { passive: true });
    doc.addEventListener('click', (e) => {
      if (Date.now() - swipedAt < 500 || e.target.closest('a') || contents.window.getSelection().toString()) return;
      // The iframe sits inside a horizontally scrolled container, so its rect
      // already accounts for the current page offset.
      zone(contents.window.frameElement.getBoundingClientRect().left + e.clientX);
    });
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') rendition.prev();
      else if (e.key === 'ArrowRight') rendition.next();
    });
  });

  rendition.on('relocated', (loc) => {
    const pct = locationsReady ? book.locations.percentageFromCfi(loc.start.cfi) : item.progress?.pct || 0;
    report(pct, { cfi: loc.start.cfi });
  });

  await rendition.display(item.progress?.cfi || undefined);
  shown = true;
  book.locations.generate(1024).then(() => {
    locationsReady = true;
    slider.disabled = false;
  });

  return {
    step: (d) => (d > 0 ? rendition.next() : rendition.prev()),
    scrubTo: (pct) => rendition.display(book.locations.cfiFromPercentage(pct)),
    destroy: () => book.destroy(),
  };
}

// ---- plain / HTML text ----------------------------------------------------------------
function mountText(content, { item, blob, prefs, zone, report, setApply, slider }) {
  const scroll = h('div', { class: 'br-text' });
  content.replaceChildren(scroll);
  setApply(() => {
    scroll.style.fontFamily = FONTS[prefs.font];
    scroll.style.fontSize = `${prefs.size}px`;
    scroll.style.lineHeight = prefs.lineHeight;
    scroll.style.setProperty('--book-margin', `${prefs.margin}px`);
  });
  const max = () => Math.max(1, scroll.scrollHeight - scroll.clientHeight);
  const pct = () => clamp(scroll.scrollTop / max(), 0, 1);

  return blob.text().then((raw) => {
    scroll.append(textToNodes(raw, item.format));
    slider.disabled = false;
    scroll.scrollTop = (item.progress?.pct || 0) * max();
    let raf;
    scroll.addEventListener('scroll', () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => report(pct()));
    }, { passive: true });
    scroll.addEventListener('click', (e) => {
      if (e.target.closest('a') || getSelection().toString()) return;
      zone(e.clientX);
    });
    return {
      step: (d) => scroll.scrollBy({ top: d * scroll.clientHeight * 0.9, behavior: 'smooth' }),
      scrubTo: (p) => { scroll.scrollTop = p * max(); },
      destroy() {},
    };
  });
}
