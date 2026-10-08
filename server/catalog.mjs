import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openAnnaStore } from './anna-store.mjs';
import { importAnna } from './import-anna.mjs';
import { parseComikey, parseWebtoon } from './public-catalogs.mjs';
import { searchRecords } from '../js/sources/catalog-search.js';

export const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function number(params, key, fallback, min, max) {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) fail(`Invalid ${key}.`);
  return value;
}
function language(params) {
  const value = params.get('language') || 'en';
  if (!/^[a-z]{2}(?:-[a-z]{2})?$/.test(value)) fail('Invalid translation language.');
  return value;
}

export function allowedOrigin(origin, extra = []) {
  if (!origin) return true;
  if (extra.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.origin === origin;
  } catch { return false; }
}

export function mangaDexSearchUrl(text, offset) {
  const url = new URL('https://api.mangadex.org/manga');
  url.search = new URLSearchParams({ limit: 30, offset });
  if (text) url.searchParams.set('title', text);
  for (const type of ['author', 'artist', 'cover_art']) url.searchParams.append('includes[]', type);
  for (const rating of ['safe', 'suggestive']) url.searchParams.append('contentRating[]', rating);
  url.searchParams.set(text ? 'order[relevance]' : 'order[followedCount]', 'desc');
  return url;
}

export function createCatalogApi(store, { fetchImpl = fetch } = {}) {
  const cache = new Map();
  let importing = false;
  async function upstream(url, body) {
    const key = `${url}:${body ? JSON.stringify(body) : ''}`;
    const hit = cache.get(key);
    if (hit?.expires > Date.now()) return hit.data;
    let response;
    try {
      response = await fetchImpl(url, {
        signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }) },
        ...(body && { method: 'POST', body: JSON.stringify(body) }),
      });
    } catch (error) { fail(`The catalog provider is unavailable: ${error.message}`, 502); }
    if (!response.ok) fail(response.status === 429 ? 'The provider is rate limiting requests. Please try again later.'
      : `The catalog provider returned HTTP ${response.status}.`, response.status === 429 ? 429 : 502);
    let data;
    try { data = await response.json(); } catch { fail('The catalog provider returned an invalid response.', 502); }
    if (cache.size >= 200) cache.delete(cache.keys().next().value);
    cache.set(key, { data, expires: Date.now() + 30000 });
    return data;
  }
  return async function api(path, params, { method = 'GET', body } = {}) {
    if (path === 'anna/import') {
      if (method !== 'POST') fail('Use POST to import metadata.', 405);
      if (importing) fail('A metadata import is already running.', 409);
      const filename = params.get('filename') || 'metadata.jsonl';
      if (!/\.(json|jsonl|ndjson)(\.(gz|zst))?$/i.test(filename)) fail('Choose a JSON, JSONL or NDJSON metadata export, optionally compressed with gzip or Zstandard.');
      importing = true;
      try { return await importAnna(body, store, { filename }); }
      catch (error) { fail(error.message); }
      finally { importing = false; }
    }
    if (method !== 'GET') fail('This catalog endpoint only supports GET.', 405);
    if (path === 'health') return { annaRecords: store.total(), importing };
    const text = (params.get('q') || '').trim();
    if (text.length > 300) fail('Search text is limited to 300 characters.');
    if (path === 'anna/search') {
      const type = params.get('type');
      if (type && !['book', 'comic'].includes(type)) fail('Invalid catalog type.');
      return store.search(text, { offset: number(params, 'offset', 0, 0, Number.MAX_SAFE_INTEGER), type });
    }
    if (path === 'mangadex/search') return upstream(mangaDexSearchUrl(text, number(params, 'offset', 0, 0, 9970)));
    if (['comikey/search', 'webtoon/search'].includes(path)) {
      const offset = number(params, 'offset', 0, 0, 100000);
      const url = path === 'comikey/search' ? `https://comikey.com/comics/?${new URLSearchParams({ q: text, page: Math.floor(offset / 30) + 1 })}`
        : 'https://www.webtoons.com/en/originals';
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) fail(`The public catalog returned HTTP ${response.status}.`, 502);
      const html = await response.text();
      if (path === 'comikey/search') { const result = parseComikey(html); return { items: result.items, next: result.next ? offset + 30 : null }; }
      return searchRecords(parseWebtoon(html).items, text, { offset });
    }
    const feed = /^mangadex\/manga\/([^/]+)\/chapters$/.exec(path);
    if (feed) {
      if (!UUID.test(feed[1])) fail('Invalid MangaDex manga ID.');
      const url = new URL(`https://api.mangadex.org/manga/${feed[1]}/feed`);
      url.search = new URLSearchParams({ limit: 100, offset: number(params, 'offset', 0, 0, 9900),
        'translatedLanguage[]': language(params), 'includes[]': 'scanlation_group', 'order[volume]': 'asc',
        'order[chapter]': 'asc', includeUnavailable: 0, includeFuturePublishAt: 0 });
      return upstream(url);
    }
    const pages = /^mangadex\/chapter\/([^/]+)\/pages$/.exec(path);
    if (pages) {
      if (!UUID.test(pages[1])) fail('Invalid MangaDex chapter ID.');
      return upstream(`https://api.mangadex.org/at-home/server/${pages[1]}`);
    }
    if (path === 'mangaupdates/search') return upstream('https://api.mangaupdates.com/v1/series/search', {
      ...(text && { search: text }), stype: 'title', page: number(params, 'page', 1, 1, 100000), perpage: 25,
      filter: 'some_releases', orderby: text ? 'score' : 'title',
    });
    const releases = /^mangaupdates\/series\/(\d+)\/releases$/.exec(path);
    if (releases) {
      if (!Number.isSafeInteger(Number(releases[1]))) fail('Invalid MangaUpdates series ID.');
      return upstream('https://api.mangaupdates.com/v1/releases/search', {
        search: releases[1], search_type: 'series', page: number(params, 'page', 1, 1, 100000),
        perpage: 25, orderby: 'date', asc: 'desc', include_metadata: true,
      });
    }
    fail('Catalog endpoint not found.', 404);
  };
}

export function createCatalogServer({ store, appRoot = APP_ROOT, origins = [], fetchImpl } = {}) {
  const api = createCatalogApi(store, { fetchImpl });
  return createServer(async (request, response) => {
    const sendJson = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/catalog/')) {
        const origin = request.headers.origin;
        if (!allowedOrigin(origin, origins)) return sendJson(403, { error: 'This app origin is not allowed by the catalog service.' });
        if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
        if (request.method === 'OPTIONS') {
          response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
          return response.end();
        }
        return sendJson(200, await api(url.pathname.slice('/api/catalog/'.length), url.searchParams, { method: request.method, body: request }));
      }
      if (!['GET', 'HEAD'].includes(request.method)) return sendJson(405, { error: 'Method not allowed.' });
      const relative = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
      const isShell = ['index.html', 'sw.js', 'manifest.webmanifest'].includes(relative);
      if ((!isShell && !/^(js|css|icons|vendor|catalog)\//.test(relative)) || relative.split('/').some((part) => part.startsWith('.'))) return sendJson(404, { error: 'Not found.' });
      const path = resolve(appRoot, relative);
      if (!path.startsWith(resolve(appRoot) + sep)) return sendJson(404, { error: 'Not found.' });
      const bytes = await readFile(path);
      response.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (!response.headersSent) sendJson(error.code === 'ENOENT' ? 404 : error.status || 500, { error: error.message });
      else response.destroy();
    }
  });
}

export function startCatalog() {
  const dbPath = process.env.UBR_ANNA_DB || resolve(APP_ROOT, 'data/anna.sqlite');
  const store = openAnnaStore(dbPath);
  const server = createCatalogServer({ store, origins: (process.env.UBR_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean) });
  const port = Number(process.env.UBR_CATALOG_PORT || 8787);
  const host = process.env.UBR_CATALOG_HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`Unified Book Registry: http://${host}:${port}\nAnna’s Archive: ${store.total()} imported metadata records.`));
  server.on('error', (error) => { console.error(error.message); store.close(); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { store.close(); process.exit(); }));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) startCatalog();
