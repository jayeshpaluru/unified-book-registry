// Cache-first app shell + vendor files; stale-while-revalidate covers (capped).
// Archive downloads and page images are never intercepted, so they are never cached here.
const VERSION = 'v2';
const SHELL = `ubr-shell-${VERSION}`;
const COVERS = `ubr-covers-${VERSION}`;
const MAX_COVERS = 300;

const SHELL_FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/db.js', 'js/util.js', 'js/pages.js', 'js/zip.js', 'js/spread.js', 'js/lib.js', 'js/items.js', 'js/importers.js',
  'js/sources/archive.js', 'js/sources/gutendex.js', 'js/sources/opds.js',
  'js/sources/catalog-api.js', 'js/sources/anna.js', 'js/sources/mangadex.js', 'js/sources/mangaupdates.js',
  'js/reader/image-reader.js', 'js/reader/book-reader.js', 'js/reader/page-source.js',
  'js/ui/dom.js', 'js/ui/grid.js', 'js/ui/item-menu.js', 'js/ui/browse.js', 'js/ui/library.js', 'js/ui/tabs.js',
  'js/ui/settings.js', 'js/ui/opds-view.js', 'js/ui/reader-view.js',
  'js/ui/catalog-view.js', 'js/ui/catalog-settings.js',
  'vendor/fflate.js', 'vendor/jszip.min.js', 'vendor/epub.min.js', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

const isCover = (url) =>
  (url.hostname === 'archive.org' && url.pathname.startsWith('/services/img/')) ||
  (url.hostname === 'www.gutenberg.org' && /\.cover\.(small|medium)\.jpg$/.test(url.pathname));

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, COVERS].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_COVERS)).map((k) => cache.delete(k)));
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(COVERS);
  const cached = await cache.match(request);
  const refresh = fetch(request).then(async (res) => {
    if (res.ok || res.type === 'opaque') {
      await cache.put(request, res.clone());
      await trim(cache);
    }
    return res;
  });
  if (cached) {
    refresh.catch(() => {});
    return cached;
  }
  return refresh;
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/catalog/')) return;
  if (url.origin === location.origin) {
    e.respondWith(caches.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request)));
  } else if (isCover(url)) {
    e.respondWith(staleWhileRevalidate(request));
  }
});
