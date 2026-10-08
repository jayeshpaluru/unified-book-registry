// Small pure helpers shared across modules.

export function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
  return res.json();
}

export function basicAuthHeader(user, pass) {
  if (!user) return {};
  const bytes = new TextEncoder().encode(`${user}:${pass || ''}`);
  return { Authorization: 'Basic ' + btoa(String.fromCharCode(...bytes)) };
}

const loading = new Map();
export function loadScript(src) {
  if (!loading.has(src)) {
    loading.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { loading.delete(src); reject(new Error(`Could not load ${src}`)); };
      document.head.append(s);
    }));
  }
  return loading.get(src);
}
