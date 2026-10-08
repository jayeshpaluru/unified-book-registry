// Tiny DOM helpers (no framework).
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

export function toast(message, ms = 3500) {
  const t = h('div', { class: 'toast', role: 'status' }, message);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

// Inline error with a retry button; replaces the container's content.
export function showError(container, message, retry) {
  container.replaceChildren(
    h('div', { class: 'notice' },
      h('p', {}, message),
      retry && h('button', { class: 'btn', onClick: retry }, 'Retry')),
  );
}

export function sheet(title, content) {
  const close = () => backdrop.remove();
  const backdrop = h('div', { class: 'sheet-backdrop', onClick: (e) => e.target === backdrop && close() },
    h('div', { class: 'sheet', role: 'dialog', 'aria-label': title },
      h('h2', {}, title), content, h('button', { class: 'btn', onClick: close }, 'Close')));
  document.body.append(backdrop);
  return close;
}
