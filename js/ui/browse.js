import { h, showError } from './dom.js';
import { debounce } from '../util.js';

// Search box + infinite-scroll grid. fetchPage(text, cursor) -> { items, next }.
export function mountBrowse(view, { title, intro, placeholder, fetchPage, renderCard }) {
  let generation = 0;
  let cursor;
  let loading = false;
  let done = false;
  let failed = false;
  let disposed = false;

  const input = h('input', { type: 'search', placeholder, 'aria-label': 'Search', enterKeyHint: 'search', autocomplete: 'off' });
  const grid = h('div', { class: 'grid' });
  const status = h('div', { class: 'status' });
  const sentinel = h('div', { class: 'sentinel' });
  view.replaceChildren(
    h('header', { class: 'page-head' }, h('h1', {}, title)),
    h('p', { class: 'muted intro' }, intro),
    h('form', { class: 'search', onSubmit: (e) => { e.preventDefault(); reset(); } }, input),
    grid, status, sentinel);

  async function loadMore() {
    if (loading || done || failed || disposed) return;
    loading = true;
    const mine = generation;
    status.textContent = 'Loading…';
    try {
      const page = await fetchPage(input.value, cursor);
      if (mine !== generation) return;
      grid.append(...page.items.map(renderCard));
      cursor = page.next;
      done = !page.next;
      status.textContent = grid.children.length ? '' : 'No results.';
    } catch (e) {
      if (mine !== generation) return;
      failed = true;
      showError(status, `Could not load results: ${e.message}`, () => { status.textContent = ''; failed = false; loading = false; loadMore(); });
    } finally {
      if (mine === generation) {
        loading = false;
        // Re-arm the observer so a still-visible sentinel triggers the next page.
        if (!failed && !disposed) {
          observer.unobserve(sentinel);
          observer.observe(sentinel);
        }
      }
    }
  }

  function reset() {
    if (disposed) return;
    generation++;
    cursor = undefined;
    done = false;
    failed = false;
    loading = false;
    grid.replaceChildren();
    loadMore();
  }

  const observer = new IntersectionObserver((entries) => entries[0].isIntersecting && loadMore(), { rootMargin: '800px' });
  observer.observe(sentinel);
  const onInput = debounce(reset, 450);
  input.addEventListener('input', onInput);
  return () => { disposed = true; generation++; observer.disconnect(); onInput.cancel(); };
}
