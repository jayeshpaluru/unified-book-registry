import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openAnnaStore } from '../server/anna-store.mjs';
import { importAnna } from '../server/import-anna.mjs';
import { createCatalogApi, createCatalogServer, allowedOrigin } from '../server/catalog.mjs';
import { mapRecord } from '../js/sources/anna.js';
import * as mangadex from '../js/sources/mangadex.js';
import * as mangaupdates from '../js/sources/mangaupdates.js';
import { catalogItem, chapterItem } from '../js/items.js';

const record = (id, title, contentType = 'book_nonfiction') => ({ id, file_unified_data: {
  title_best: title, author_best: 'Michele Boldrin, David K. Levine', content_type_best: contentType,
  language_codes: ['en'], extension_best: 'pdf', identifiers_unified: { isbn13: ['978-0-521-87928-6'] },
} });
const first = record('md5:8336332bf5877e3adbfb60ac70720cd5', 'Against intellectual monopoly');
const second = record('md5:00000000000000000000000000000002', 'A comic collection', 'book_comic');
const mangaId = '0a580438-bc72-4503-940b-12a5da881b56';
const chapterId = '93ea0d72-169d-4418-b48d-95091972a871';

test('Untitled combined records retain their IDs, filenames and searchable metadata', async (t) => {
  const store = openAnnaStore(); t.after(() => store.close());
  const untitled = { _id: 'md5:00000000000000000000000000000004', _source: { file_unified_data: {
    title_best: '', original_filename_best: 'C:\\collection\\Original file.pdf', author_best: 'Known author',
    identifiers_unified: { isbn13: ['978-0-521-87928-6'] }, content_type_best: 'book_comic',
  } } };
  await importAnna([Buffer.from(JSON.stringify(untitled))], store);
  const imported = store.search('9780521879286', { type: 'comic' }).items[0];
  assert.equal(store.total(), 1); assert.equal(imported.id, untitled._id);
  assert.equal(imported.title, 'Original file.pdf'); assert.equal(imported.titleIsFallback, true);
  assert.equal(store.search('Known author').total, 1);
  assert.equal(mapRecord({ id: 'missing-title', file_unified_data: {} }).title, 'Untitled record');
  assert.equal(mapRecord({ id: 'missing-title', file_unified_data: { title_best: ' ', title_additional: ['', ' Alternate title '] } }).title, 'Alternate title');
  assert.equal(mapRecord({ id: 'not-a-combined-record' }), null);
  assert.equal(mapRecord({ id: 'invalid', file_unified_data: [] }), null);
  assert.equal(mapRecord(first).titleIsFallback, undefined);
});

test('Anna import supports compressed, split UTF-8 JSONL and filters comics from books', async (t) => {
  for (const [filename, compress] of [['metadata.jsonl', (b) => b], ['metadata.jsonl.gz', gzipSync], ['metadata.jsonl.zst', zstdCompressSync], ['aarecords__0.json.gz', gzipSync]]) {
    const store = openAnnaStore();
    t.after(() => store.close());
    const bytes = compress(Buffer.from([JSON.stringify(first), '', JSON.stringify(second),
      JSON.stringify(record('md5:00000000000000000000000000000003', 'Café 日本語'))].join('\r\n')));
    const chunks = Array.from({ length: Math.ceil(bytes.length / 7) }, (_, i) => bytes.subarray(i * 7, (i + 1) * 7));
    assert.equal((await importAnna(chunks, store, { filename })).total, 3);
    assert.equal(store.search('monopoly Levine').total, 1);
    assert.equal(store.search('978-0-521-87928-6').total, 3);
    assert.equal(store.search('日本語').total, 1);
    assert.equal(store.search('', { type: 'comic' }).items[0].title, 'A comic collection');
    assert.equal(store.search('', { type: 'book' }).total, 2);
    assert.equal(store.search('', { limit: 2 }).next, 2);
    assert.equal(store.search('', { offset: 2, limit: 2 }).next, null);
    assert.equal(store.search('" OR * --').total, 0);
  }
});

test('Anna imports update records and the search index without resetting IDs or duplicating entries', async (t) => {
  const store = openAnnaStore(); t.after(() => store.close());
  await importAnna([Buffer.from(JSON.stringify(first))], store);
  const changed = record(first.id.toUpperCase(), 'A replacement title', 'book_comic');
  await importAnna([Buffer.from(JSON.stringify({ _id: changed.id, _source: changed }))], store);
  assert.equal(store.total(), 1);
  assert.equal(store.search('monopoly').total, 0);
  assert.equal(store.search('replacement', { type: 'comic' }).total, 1);
});

test('Anna JSON arrays and Elasticsearch hits preserve multibyte characters across input chunks', async (t) => {
  const store = openAnnaStore(); t.after(() => store.close());
  const json = Buffer.from(JSON.stringify({ hits: { hits: [{ _id: first.id,
    _source: { file_unified_data: { ...first.file_unified_data, title_best: '日本語 Café' } } }] } }));
  const chunks = [...json].map((b) => Buffer.from([b]));
  await importAnna(chunks, store, { filename: 'export.json' });
  assert.equal(store.search('日本語').items[0].title, '日本語 Café');
});

test('Unsupported AAC and broken imports report failure while preserving existing metadata', async (t) => {
  const store = openAnnaStore(); t.after(() => store.close());
  await importAnna([Buffer.from(JSON.stringify(first))], store);
  await assert.rejects(importAnna([Buffer.from('{"aacid":"raw","data":{"title":"Unsupported"}}')], store), /No combined/);
  assert.equal(store.total(), 1);
  await assert.rejects(importAnna([Buffer.from(`${JSON.stringify(second)}\n{bad`)], store), /0 records committed/);
  assert.equal(store.total(), 1);
  await assert.rejects(importAnna([Buffer.from(`${JSON.stringify(second)}\n{bad`)], store, { batchSize: 1 }), /1 records committed/);
  assert.equal(store.total(), 2);
  await assert.rejects(importAnna([Buffer.from('broken gzip')], store, { filename: 'bad.jsonl.gz' }), /Import failed/);
  assert.equal(store.total(), 2);
});

test('Anna metadata persists across restarts', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ubr-catalog-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = openAnnaStore(join(dir, 'anna.sqlite'));
  store.put(mapRecord(first)); store.close();
  store = openAnnaStore(join(dir, 'anna.sqlite')); t.after(() => store.close());
  assert.equal(store.search('monopoly').total, 1);
});

test('Import progress safety stops preserve committed batches and the original error', async (t) => {
  const store = openAnnaStore(); t.after(() => store.close());
  await assert.rejects(importAnna([Buffer.from(JSON.stringify(first))], store, {
    batchSize: 1, onProgress: () => { throw new Error('Disk reserve reached'); },
  }), /Disk reserve reached \(1 records committed/);
  assert.equal(store.total(), 1);
  await assert.rejects(importAnna([Buffer.from(JSON.stringify(second))], store, {
    onProgress: () => { throw new Error('Disk reserve reached'); },
  }), /Disk reserve reached \(1 records committed/);
  assert.equal(store.total(), 2);
});

test('Cancellation interrupts a waiting metadata stream and rolls back only its unfinished batch', async (t) => {
  for (const compressed of [false, true]) {
    const store = openAnnaStore(); t.after(() => store.close());
    const third = record('md5:00000000000000000000000000000003', 'Pending third record');
    const raw = Buffer.from([first, second, third].map(value => JSON.stringify(value)).join('\n') + '\n');
    let sent = false;
    const source = new Readable({ read() { if (!sent) { sent = true; this.push(compressed ? gzipSync(raw) : raw); } } });
    const controller = new AbortController();
    let timer;
    t.after(() => clearTimeout(timer));
    await assert.rejects(importAnna(source, store, {
      filename: compressed ? 'waiting.jsonl.gz' : 'waiting.jsonl', batchSize: 2, signal: controller.signal,
      onProgress() { timer = setTimeout(() => controller.abort(new DOMException('Fixture stop', 'AbortError')), 20); },
    }), /2 records committed/);
    assert.equal(source.destroyed, true);
    assert.equal(store.total(), 2);
    assert.equal(store.search('Pending third').total, 0);
    assert.equal(store.completedImport('waiting'), false);
  }
});

test('An idle metadata stream fails closed with its source released and committed batches preserved', async (t) => {
  const store = openAnnaStore(); t.after(() => store.close());
  let sent = false;
  const source = new Readable({ read() { if (!sent) { sent = true; this.push(gzipSync(Buffer.from(JSON.stringify(first) + '\n'))); } } });
  await assert.rejects(importAnna(source, store, { filename: 'idle.jsonl.gz', batchSize: 1, idleTimeoutMs: 50 }), /made no progress.*1 records committed/);
  assert.equal(source.destroyed, true); assert.equal(store.total(), 1);
  assert.equal(store.completedImport('idle'), false);
  assert.throws(() => store.rollback(), /no transaction/i);
});

test('Compressed source errors and multi-member gzip checksums are not accepted as successful imports', async (t) => {
  const store = openAnnaStore(); t.after(() => store.close());
  async function* failedSource() { yield gzipSync(Buffer.from(JSON.stringify(first) + '\n')); throw new Error('Fixture read failure'); }
  await assert.rejects(importAnna(failedSource(), store, { filename: 'failed.jsonl.gz' }), /Fixture read failure/);
  assert.equal(store.total(), 0);
  const members = [first, second].map(value => gzipSync(Buffer.from(JSON.stringify(value) + '\n')));
  assert.equal((await importAnna(members, store, { filename: 'members.jsonl.gz' })).imported, 2);
  const corrupt = Buffer.from(members[1]); corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(importAnna([members[0], corrupt], store, { filename: 'bad-members.jsonl.gz' }), /Import failed/);
  assert.equal(store.total(), 2);
});

test('MangaDex maps localized series, credited chapters and image pages', () => {
  const manga = mangadex.mapManga({ id: mangaId, attributes: { title: { ja: '日本語' }, originalLanguage: 'ja',
    availableTranslatedLanguages: ['en', 'fr'] }, relationships: [
      { type: 'author', attributes: { name: 'Author' } }, { type: 'artist', attributes: { name: 'Author' } },
      { type: 'cover_art', attributes: { fileName: 'cover.jpg' } },
    ] });
  assert.equal(manga.title, '日本語'); assert.equal(manga.author, 'Author');
  assert.match(manga.cover, /cover\.jpg\.256\.jpg$/);
  const chapter = mangadex.mapChapter({ id: chapterId, attributes: { chapter: '1', pages: 2, translatedLanguage: 'en' },
    relationships: [{ type: 'scanlation_group', id: mangaId, attributes: { name: 'Example group' } }] });
  assert.equal(chapter.groups[0].name, 'Example group');
  const item = chapterItem(manga, chapter);
  assert.equal(item.format, 'mangadex'); assert.equal(item.mode, 'rtl');
  assert.equal(item.scanlationGroups[0].name, 'Example group');
  assert.equal(mangadex.mapFeed({ offset: 0, limit: 100, total: 1,
    data: [{ id: chapterId, attributes: { pages: 5, isUnavailable: true } }] }).items.length, 0);
  assert.deepEqual(mangadex.mapPages({ baseUrl: 'https://images.example', chapter: { hash: 'abc', data: ['1.jpg', '2.jpg'] } }),
    ['https://images.example/data/abc/1.jpg', 'https://images.example/data/abc/2.jpg']);
  assert.throws(() => mangadex.mapPages({ baseUrl: 'https://images.example', chapter: { data: [] } }), /no readable pages/);
});

test('MangaUpdates keeps series IDs, release dates and group credits', () => {
  const result = mangaupdates.mapSearch({ page: 1, per_page: 25, total_hits: 26,
    results: [{ record: { series_id: 23606352927, title: 'Yotsuba to!', image: { url: { thumb: 'https://cdn.example/cover.jpg' } } } }] });
  assert.equal(result.next, 2); assert.equal(result.items[0].id, '23606352927');
  assert.equal(catalogItem(result.items[0]).id, 'catalog:mangaupdates:23606352927');
  const release = mangaupdates.mapReleases({ page: 1, per_page: 25, total_hits: 1, results: [{ record: {
    id: 123, chapter: '12.5', release_date: '2026-10-07', groups: [{ group_id: 42, name: 'Example scans' }],
  } }] });
  assert.equal(release.items[0].chapter, '12.5'); assert.equal(release.items[0].groups[0].name, 'Example scans');
  assert.equal(release.next, null);
});

test('Catalog API shapes read-only provider requests, caches repeated queries and validates IDs', async (t) => {
  const store = openAnnaStore(); t.after(() => store.close());
  const calls = [];
  const api = createCatalogApi(store, { fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init }); return new Response(JSON.stringify({ data: [], total: 0 }));
  } });
  const params = new URLSearchParams({ q: 'One Piece & friends', offset: '30' });
  await api('mangadex/search', params); await api('mangadex/search', params);
  assert.equal(calls.length, 1);
  const search = new URL(calls[0].url);
  assert.equal(search.searchParams.get('title'), 'One Piece & friends');
  assert.equal(search.searchParams.get('offset'), '30');
  assert.deepEqual(search.searchParams.getAll('includes[]'), ['author', 'artist', 'cover_art']);
  await api(`mangadex/manga/${mangaId}/chapters`, new URLSearchParams({ language: 'pt-br' }));
  assert.equal(new URL(calls[1].url).searchParams.get('translatedLanguage[]'), 'pt-br');
  await api('mangaupdates/search', new URLSearchParams({ q: 'Yotsuba', page: '2' }));
  assert.equal(calls[2].init.method, 'POST');
  assert.equal(JSON.parse(calls[2].init.body).page, 2);
  assert.equal(JSON.parse(calls[2].init.body).search, 'Yotsuba');
  await api('mangaupdates/search', new URLSearchParams());
  const browse = JSON.parse(calls[3].init.body);
  assert.equal(Object.hasOwn(browse, 'search'), false, 'MangaUpdates rejects an empty search string; omit it for browsing.');
  assert.equal(browse.orderby, 'title');
  await assert.rejects(api('mangadex/manga/not-an-id/chapters', new URLSearchParams()), /Invalid MangaDex/);
  await assert.rejects(api('anna/search', new URLSearchParams({ offset: '-1' })), /Invalid offset/);
  await assert.rejects(api('health', new URLSearchParams(), { method: 'DELETE' }), /only supports GET/);
});

test('Provider rate limits are surfaced without automatic retrying', async (t) => {
  const store = openAnnaStore(); t.after(() => store.close());
  let calls = 0;
  const api = createCatalogApi(store, { fetchImpl: async () => { calls++; return new Response('', { status: 429 }); } });
  await assert.rejects(api('mangadex/search', new URLSearchParams()), (error) => error.status === 429);
  assert.equal(calls, 1);
});

test('HTTP catalog serves the app, imports metadata and restricts database/file exposure', async (t) => {
  const store = openAnnaStore();
  const server = createCatalogServer({ store });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.close(); await once(server, 'close'); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base)).status, 200);
  const upload = await fetch(`${base}/api/catalog/anna/import?filename=export.jsonl.gz`, {
    method: 'POST', body: gzipSync(Buffer.from(JSON.stringify(first))), headers: { 'Content-Type': 'application/octet-stream' },
  });
  assert.equal(upload.status, 200); assert.equal((await upload.json()).total, 1);
  const response = await fetch(`${base}/api/catalog/anna/search?q=monopoly&type=book`, { headers: { Origin: 'http://localhost:8080' } });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8080');
  assert.equal((await response.json()).items[0].title, first.file_unified_data.title_best);
  assert.equal((await fetch(`${base}/api/catalog/health`, { headers: { Origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await fetch(`${base}/.git/config`)).status, 404);
  assert.equal((await fetch(`${base}/data/anna.sqlite`)).status, 404);
  assert.equal(allowedOrigin('http://127.0.0.1.evil.example'), false);
});
