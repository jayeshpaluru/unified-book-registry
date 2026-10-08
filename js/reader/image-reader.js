// Image reader: paged LTR/RTL (with landscape two-page spreads) and vertical scroll.
import { h } from '../ui/dom.js';
import { clamp, debounce } from '../util.js';
import { buildSpreads, spreadIndexOf, visualOrder, wantsSpread } from '../spread.js';
import { sourceLink } from '../ui/links.js';

const PRELOAD = 2;
const MAX_ZOOM = 5;
const DOUBLE_TAP_MS = 220;
const SWIPE_PX = 50;
const MODES = ['ltr', 'rtl', 'vertical'];
const MODE_LABEL = { ltr: 'Paged ›', rtl: '‹ Paged', vertical: 'Scroll' };

// opts: { item, source, onPage(page, count), onSettings(patch), onClose() }
export function mountImageReader(host, opts) {
  const { item, source, onPage, onSettings, onClose } = opts;
  const count = source.count;
  let mode = item.mode || 'ltr';
  let fit = item.fit || 'screen';
  let coverSingle = item.coverSingle ?? true;
  let page = clamp(item.progress?.page ?? 0, 0, count - 1);
  let spreads = [];
  let token = 0;
  let overlayTimer;
  let disposed = false;
  const urls = new Map(); // page index -> Promise<url>
  let zoom = { s: 1, x: 0, y: 0 };

  // ---- DOM -------------------------------------------------------------
  const view = h('div', { class: 'ir-view' });
  const stage = h('div', { class: 'ir-stage' }, view);
  const scroller = h('div', { class: 'ir-scroll' });
  const title = h('span', { class: 'ir-title' }, item.title);
  const modeBtn = h('button', { class: 'btn-quiet', onClick: cycleMode });
  const fitBtn = h('button', { class: 'btn-quiet', onClick: toggleFit });
  const coverBtn = h('button', { class: 'btn-quiet', onClick: toggleCover }, 'Cover');
  const label = h('span', { class: 'ir-label' });
  const slider = h('input', { type: 'range', min: 0, max: count - 1, step: 1, 'aria-label': 'Page' });
  const top = h('header', { class: 'ir-bar ir-top' },
    h('button', { class: 'btn-quiet', onClick: close, 'aria-label': 'Close' }, 'Close'), title, modeBtn, fitBtn, coverBtn);
  if (item.sourceName) top.append(h('span', { class: 'reader-credit' },
    sourceLink(item.sourceName, item.readUrl, 'credit-link') || item.sourceName,
    ...(item.scanlationGroups || []).map((group) => [' · ', sourceLink(group.name, group.url, 'credit-link') || group.name])));
  const bottom = h('footer', { class: 'ir-bar ir-bottom' }, slider, label);
  const root = h('div', { class: 'ir' }, stage, scroller, top, bottom);
  host.replaceChildren(root);

  // ---- image window ------------------------------------------------------
  function load(i) {
    if (!urls.has(i)) {
      const p = source.getUrl(i);
      p.catch(() => urls.delete(i)); // allow a retry after a failure
      urls.set(i, p);
    }
    return urls.get(i);
  }

  // Keep pages [lo, hi] loaded (or loading); revoke everything else.
  function setWindow(lo, hi) {
    for (const [i, p] of urls) {
      if (i < lo || i > hi) {
        urls.delete(i);
        p.then((u) => source.release(u), () => {});
      }
    }
    for (let i = Math.max(0, lo); i <= Math.min(count - 1, hi); i++) load(i).catch(() => {});
  }

  let refreshing = false;
  async function retryPages() {
    if (refreshing || disposed) return;
    refreshing = true;
    try {
      if (source.refresh) {
        const target = mode === 'vertical' ? scroller.children[page] : view;
        target.replaceChildren(h('div', { class: 'notice', role: 'status' }, 'Refreshing chapter page links…'));
        await source.refresh();
        if (disposed) return;
        for (const promise of urls.values()) promise.then((url) => source.release(url), () => {});
        urls.clear(); loadedVertical.clear();
      }
      if (mode === 'vertical') syncVertical(); else showSpread();
    } catch (error) {
      if (disposed) return;
      const target = mode === 'vertical' ? scroller.children[page] : view;
      target.replaceChildren(h('div', { class: 'notice' }, h('p', {}, error.message), h('button', { class: 'btn', onClick: retryPages }, 'Retry')));
    } finally { refreshing = false; }
  }

  // ---- shared UI -----------------------------------------------------------
  const rtl = () => mode === 'rtl';

  function updateChrome() {
    label.textContent = `${page + 1} / ${count}`;
    slider.value = page;
    slider.dir = rtl() && mode !== 'vertical' ? 'rtl' : 'ltr';
    modeBtn.textContent = MODE_LABEL[mode];
    fitBtn.textContent = fit === 'screen' ? 'Fit screen' : 'Fit width';
    fitBtn.hidden = mode === 'vertical';
    coverBtn.hidden = mode === 'vertical' || !spreadOn();
    coverBtn.classList.toggle('on', coverSingle);
  }

  function setOverlay(show) {
    clearTimeout(overlayTimer);
    root.classList.toggle('show-bars', show);
    if (show) overlayTimer = setTimeout(() => setOverlay(false), 3500);
  }
  const toggleOverlay = () => setOverlay(!root.classList.contains('show-bars'));

  function setPage(p) {
    page = clamp(p, 0, count - 1);
    updateChrome();
    onPage(page, count);
  }

  function close() {
    destroy();
    onClose();
  }

  function cycleMode() {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    onSettings({ mode });
    layout();
    setOverlay(true);
  }

  function toggleFit() {
    fit = fit === 'screen' ? 'width' : 'screen';
    onSettings({ fit });
    layout();
    setOverlay(true);
  }

  function toggleCover() {
    coverSingle = !coverSingle;
    onSettings({ coverSingle });
    layout();
    setOverlay(true);
  }

  // ---- paged mode ------------------------------------------------------
  const spreadOn = () => wantsSpread(innerWidth, innerHeight);
  let si = 0;

  function layout() {
    token++;
    const vertical = mode === 'vertical';
    root.dataset.mode = mode;
    stage.hidden = vertical;
    scroller.hidden = !vertical;
    view.replaceChildren();
    scroller.replaceChildren();
    if (vertical) {
      buildScroller();
    } else {
      spreads = buildSpreads(count, { spread: spreadOn(), coverSingle });
      si = spreadIndexOf(spreads, page);
      showSpread();
    }
    updateChrome();
  }

  async function showSpread() {
    const mine = ++token;
    const group = spreads[si];
    setPage(group[0]);
    setWindow(group[0] - PRELOAD, group[group.length - 1] + PRELOAD);
    try {
      const srcs = await Promise.all(group.map(load));
      if (mine !== token) return;
      const imgs = visualOrder(group, rtl()).map((i) => {
        return h('img', { src: srcs[group.indexOf(i)], alt: `Page ${i + 1}` });
      });
      await Promise.all(imgs.map((img) => img.decode().catch(() => { throw new Error('The image host did not provide a readable page. It may be unavailable or block this browser.'); })));
      if (mine !== token) return;
      view.className = `ir-view fit-${fit}${group.length > 1 ? ' two' : ''}`;
      view.replaceChildren(...imgs);
      resetZoom();
    } catch (e) {
      if (mine !== token) return;
      view.replaceChildren(h('div', { class: 'notice' },
        h('p', {}, `Could not load page ${group[0] + 1}: ${e.message}`),
        h('button', { class: 'btn', onClick: retryPages }, 'Retry')));
    }
  }

  function turn(dir) {
    const next = si + dir;
    if (next < 0 || next >= spreads.length) return;
    si = next;
    showSpread();
  }

  function goTo(p) {
    if (mode === 'vertical') {
      scroller.children[p]?.scrollIntoView();
      setPage(p);
    } else {
      si = spreadIndexOf(spreads, p);
      showSpread();
    }
  }

  // ---- zoom / pan ------------------------------------------------------------
  function clampZoom() {
    const W = stage.clientWidth, H = stage.clientHeight;
    const cw = view.offsetWidth * zoom.s, ch = view.offsetHeight * zoom.s;
    zoom.x = cw <= W ? (W - cw) / 2 : clamp(zoom.x, W - cw, 0);
    zoom.y = ch <= H ? (H - ch) / 2 : clamp(zoom.y, H - ch, 0);
  }
  function applyZoom() {
    clampZoom();
    view.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
  }
  function resetZoom() {
    zoom = { s: 1, x: 0, y: 0 };
    applyZoom();
  }
  function zoomAt(px, py, s) {
    const ns = clamp(s, 1, MAX_ZOOM);
    zoom.x = px - (px - zoom.x) * (ns / zoom.s);
    zoom.y = py - (py - zoom.y) * (ns / zoom.s);
    zoom.s = ns;
    if (ns === 1) { zoom.x = 0; zoom.y = 0; }
    applyZoom();
  }
  const zoomed = () => zoom.s > 1.02;
  const canPanX = () => view.offsetWidth * zoom.s > stage.clientWidth + 1;

  // ---- pointer gestures ------------------------------------------------------
  const pointers = new Map();
  let pinch = null;
  let multi = false; // a second finger touched during this gesture
  let lastTap = null;
  let tapTimer;

  function stagePoint(e) {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, t: Date.now() });
    if (pointers.size === 2) {
      multi = true;
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: zoom.s };
    }
  });

  stage.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const r = stage.getBoundingClientRect();
      const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
      zoomAt(cx, cy, pinch.s * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
    } else if (pointers.size === 1 && !multi) {
      zoom.x += dx;
      zoom.y += dy;
      applyZoom();
    }
  });

  function endPointer(e) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    pointers.delete(e.pointerId);
    pinch = null;
    if (pointers.size > 0) return;
    const wasMulti = multi;
    multi = false;
    if (wasMulti) return;
    const dx = e.clientX - p.sx, dy = e.clientY - p.sy;
    const moved = Math.hypot(dx, dy);
    if (e.type === 'pointercancel') return;
    if (moved < 10 && Date.now() - p.t < 400) {
      tap(stagePoint(e));
    } else if (!canPanX() && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > 1.5 * Math.abs(dy)) {
      turn(dx < 0 === !rtl() ? 1 : -1);
    }
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  function tap(pt) {
    const now = Date.now();
    if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(pt.x - lastTap.x, pt.y - lastTap.y) < 30) {
      clearTimeout(tapTimer);
      lastTap = null;
      zoomed() ? zoomAt(pt.x, pt.y, 1) : zoomAt(pt.x, pt.y, 2.5);
      return;
    }
    lastTap = { ...pt, t: now };
    tapTimer = setTimeout(() => { lastTap = null; singleTap(pt); }, DOUBLE_TAP_MS);
  }

  function singleTap(pt) {
    const third = stage.clientWidth / 3;
    if (pt.x > third && pt.x < 2 * third) return toggleOverlay();
    if (zoomed()) return;
    const right = pt.x >= 2 * third;
    turn(right === !rtl() ? 1 : -1);
  }

  // ---- vertical (webtoon) mode ---------------------------------------------------
  let loadedVertical = new Set();

  function buildScroller() {
    loadedVertical = new Set();
    for (let i = 0; i < count; i++) {
      scroller.append(h('div', { class: 'ir-slot', dataset: { i } }));
    }
    requestAnimationFrame(() => {
      scroller.children[page]?.scrollIntoView();
      syncVertical();
    });
  }

  function currentVerticalPage() {
    const mid = scroller.scrollTop + scroller.clientHeight / 3;
    let lo = 0, hi = count - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (scroller.children[m].offsetTop <= mid) lo = m; else hi = m - 1;
    }
    return lo;
  }

  async function syncVertical() {
    if (mode !== 'vertical') return;
    const cur = currentVerticalPage();
    if (cur !== page) setPage(cur);
    const lo = cur - PRELOAD, hi = cur + PRELOAD;
    setWindow(lo, hi);
    for (const i of [...loadedVertical]) {
      if (i < lo || i > hi) {
        const slot = scroller.children[i];
        slot.style.height = `${slot.offsetHeight}px`;
        slot.replaceChildren();
        loadedVertical.delete(i);
      }
    }
    for (let i = Math.max(0, lo); i <= Math.min(count - 1, hi); i++) {
      if (loadedVertical.has(i)) continue;
      loadedVertical.add(i);
      const slot = scroller.children[i];
      load(i).then((src) => {
        if (!loadedVertical.has(i)) return;
        const img = h('img', { src, alt: `Page ${i + 1}` });
        img.onload = () => { slot.style.height = ''; };
        img.onerror = () => {
          loadedVertical.delete(i);
          slot.replaceChildren(h('div', { class: 'notice' }, h('p', {}, `Page ${i + 1}: The image host did not provide a readable page.`),
            h('button', { class: 'btn', onClick: retryPages }, 'Retry')));
        };
        slot.replaceChildren(img);
      }).catch((e) => {
        loadedVertical.delete(i);
        slot.replaceChildren(h('div', { class: 'notice' },
          h('p', {}, `Page ${i + 1}: ${e.message}`),
          h('button', { class: 'btn', onClick: retryPages }, 'Retry')));
      });
    }
  }

  scroller.addEventListener('scroll', debounce(syncVertical, 80), { passive: true });
  scroller.addEventListener('click', () => toggleOverlay());

  // ---- scrubber, keyboard, resize -------------------------------------------------
  slider.addEventListener('input', () => { label.textContent = `${Number(slider.value) + 1} / ${count}`; clearTimeout(overlayTimer); });
  slider.addEventListener('change', () => { goTo(Number(slider.value)); setOverlay(true); });

  function onKey(e) {
    if (e.key === 'Escape') return close();
    if (mode === 'vertical' || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    turn((e.key === 'ArrowRight') === !rtl() ? 1 : -1);
  }
  document.addEventListener('keydown', onKey);

  // Fold/unfold, rotation and split-view all arrive as resize; keep the page.
  const onResize = debounce(() => {
    if (mode === 'vertical') return syncVertical();
    const wasSpread = spreads.some((g) => g.length > 1);
    if (wasSpread !== spreadOn()) layout(); else applyZoom();
  }, 120);
  window.addEventListener('resize', onResize);

  function destroy() {
    disposed = true;
    token++;
    clearTimeout(overlayTimer);
    clearTimeout(tapTimer);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    setWindow(Infinity, -Infinity);
    host.replaceChildren();
  }

  layout();
  setOverlay(true);
  return { destroy };
}
