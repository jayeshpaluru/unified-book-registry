import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReaderSeries, parseReaderChapters, parseReaderPages, createPublicReaderClient, resolveGetComicsDownload } from '../server/public-readers.mjs';
import { directSearch } from '../js/sources/getcomics.js';
import { getComicsDownloads, mapGetComics, httpsUrl, metadataJson } from '../js/sources/public-metadata.js';
import { scanlationItem } from '../js/items.js';

const seriesId = '01J76XY7E9FNDZ1DBBM6PBJPFK', chapterId = '01M3DVDYA933SQQ6703XQYMMGQ';
const comic = { id: 123, title: { rendered: 'A &amp; B #1 (2026)' }, link: 'https://getcomics.org/other-comics/a-b/',
  content: { rendered: '<img src="https://getcomics.org/c.jpg"><p>Do not copy this story synopsis.</p><a href="http://getcomics.org/dls/public-link">DOWNLOAD NOW</a>' } };

test('Reader directories retain factual titles/covers, deduplicate anchors and ignore foreign/script links', () => {
  const mp = parseReaderSeries('mangapill', '<a href="/manga/2/one-piece"><img data-src="https://images.example/2.webp" alt="One Piece One Piece"></a><a href="/manga/2/one-piece">One Piece</a>' +
    '<a href="https://evil.example/manga/3">Foreign</a><script><a href="/manga/4">Script</a></script>');
  assert.equal(mp.length, 1); assert.equal(mp[0].title, 'One Piece'); assert.equal(mp[0].cover, 'https://images.example/2.webp');
  assert.equal(mp[0].source, 'mangapill');
  const wc = parseReaderSeries('weebcentral', `<a href="https://weebcentral.com/series/${seriesId}/One-Piece"><img src="https://images.example/cover.jpg" alt="One Piece cover"></a>`);
  assert.equal(wc[0].id, seriesId); assert.equal(wc[0].title, 'One Piece');
  assert.throws(() => parseReaderSeries('unknown', ''), /Unknown/);
});
test('Provider chapter lists sort numeric/decimal chapters and never invent scanlation credits', () => {
  const chapters = parseReaderChapters('mangapill', '<a href="/chapters/2-11000000/x">Chapter 10</a><a href="/chapters/2-10250000/x">Chapter 2.5</a><a href="/chapters/2-10200000/x">Chapter 2</a><a href="/chapters/2-10200000/x">Chapter 2</a>');
  assert.deepEqual(chapters.map((c) => c.chapter), ['2', '2.5', '10']); assert.deepEqual(chapters[0].groups, []);
  const wc = parseReaderChapters('weebcentral', `<a href="/chapters/${chapterId}">Chapter 1194</a>`);
  assert.equal(wc[0].id, chapterId); assert.equal(wc[0].chapter, '1194');
  const item = scanlationItem({ id: seriesId, title: 'One Piece', source: 'weebcentral', sourceName: 'Weeb Central' }, wc[0]);
  assert.equal(item.format, 'scanlation'); assert.equal(item.provider, 'weebcentral'); assert.equal(item.chapterId, chapterId);
  assert.throws(() => parseReaderChapters('unknown', ''), /Unknown/);
});
test('Page manifests keep original page order and reject credentials, local hosts, HTML scripts and unsupported schemes', () => {
  const mp = parseReaderPages('mangapill', '<img src="https://images.example/cover.jpg"><img class="js-page" data-src="https://images.example/2.jpg"><img class="js-page" data-src="https://images.example/1.jpg"><img class="js-page" data-src="https://images.example/1.jpg">' +
    '<script><img class="js-page" src="https://images.example/script.jpg"></script><img class="js-page" src="javascript:alert(1)">');
  assert.deepEqual(mp.pages, ['https://images.example/2.jpg', 'https://images.example/1.jpg']);
  assert.deepEqual(parseReaderPages('weebcentral', '<img alt="Page 1" src="https://images.example/1.png"><img alt="cover" src="https://images.example/cover.jpg">').pages, ['https://images.example/1.png']);
  for (const url of ['https://127.0.0.1/x', 'https://user:pass@images.example/x', 'https://foo.local/x', 'https://[::1]/x', 'https://images.example:444/x', 'http://images.example/x', '']) assert.equal(httpsUrl(url), null);
  assert.throws(() => parseReaderPages('mangapill', ''), /no usable/);
});
test('Public reader client uses anonymous documented frontend parameters, caches metadata and validates IDs before fetching', async () => {
  const calls = [], client = createPublicReaderClient({ fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(`<a href="/series/${seriesId}/One-Piece"><img alt="One Piece cover" src="https://images.example/cover.jpg"></a>`);
  } });
  assert.equal((await client.search('weebcentral', 'One Piece')).items.length, 1);
  await client.search('weebcentral', 'One Piece'); assert.equal(calls.length, 1);
  const url = new URL(calls[0].url); assert.equal(url.searchParams.get('text'), 'One Piece'); assert.equal(url.searchParams.get('sort'), 'Best Match');
  assert.equal(url.searchParams.get('adult'), 'False'); assert.equal(calls[0].init.headers['HX-Request'], 'true');
  assert.equal(calls[0].init.redirect, 'manual'); assert.equal(calls[0].init.headers.Authorization, undefined);
  await assert.rejects(client.chapters('mangapill', '../escape'), /Invalid/);
  await assert.rejects(client.pages('weebcentral', 'not-a-reference'), /Invalid/);
  await assert.rejects(client.search('mangapill', '', -1), /Invalid/);
  assert.equal(calls.length, 1);
});
test('MangaPill live search follows real page cursors; long chapter feeds paginate without missing chapters', async () => {
  const client = createPublicReaderClient({ fetchImpl: async (url) => new Response(String(url).includes('/search')
    ? '<a href="/manga/2/one-piece">One Piece</a><a href="?q=x&amp;page=3">Next</a>'
    : Array.from({ length: 105 }, (_, i) => `<a href="/chapters/2-${1000 + i}/x">Chapter ${i + 1}</a>`).join('')) });
  const result = await client.search('mangapill', 'x', 2); assert.equal(result.next, 3);
  const first = await client.chapters('mangapill', '2'), second = await client.chapters('mangapill', '2', 100);
  assert.equal(first.total, 105); assert.equal(first.items.length, 100); assert.equal(first.next, 100);
  assert.equal(second.items.length, 5); assert.equal(second.items[0].chapter, '101'); assert.equal(second.next, null);
});
test('Public provider errors, oversized metadata and cross-origin redirects fail without bypasses or retries', async () => {
  let count = 0;
  const blocked = createPublicReaderClient({ fetchImpl: async () => { count++; return new Response('', { status: 403 }); } });
  await assert.rejects(blocked.search('mangapill'), /HTTP 403/); assert.equal(count, 1);
  const redirected = createPublicReaderClient({ fetchImpl: async () => new Response('', { status: 302, headers: { Location: 'https://evil.example/login' } }) });
  await assert.rejects(redirected.search('mangapill'), /unsupported origin/);
  const large = createPublicReaderClient({ fetchImpl: async () => new Response('small body', { headers: { 'Content-Length': '9000000' } }) });
  await assert.rejects(large.search('mangapill'), /size/);
  await assert.rejects(metadataJson(new Response('12345'), 3), /size/);
});
test('GetComics keeps archive metadata without copying synopses or presenting remote readers/ads as download choices', () => {
  const mapped = mapGetComics(comic);
  assert.equal(mapped.title, 'A & B #1 (2026)'); assert.equal(mapped.year, '2026'); assert.equal(mapped.source, 'getcomics');
  assert.doesNotMatch(mapped.summary, /story synopsis/);
  assert.deepEqual(mapped.downloads, [{ label: 'DOWNLOAD NOW', url: 'https://getcomics.org/dls/public-link' }]);
  assert.deepEqual(getComicsDownloads('<a href="https://evil.example/file.cbz">DOWNLOAD NOW</a><a href="https://readcomicsonline.ru/a">READ ONLINE</a><a href="https://getcomics.org/ad">DOWNLOAD NOW</a><script><a href="https://pixeldrain.com/u/x">PIXELDRAIN</a></script>'), []);
});
test('GetComics search filters non-archive posts but advances the original provider cursor, with bounded responses', async () => {
  const calls = [];
  const result = await directSearch('A & B', 30, { fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify([comic, { ...comic, id: 124, content: { rendered: 'News only' } }]), { headers: { 'X-WP-Total': '100' } });
  } });
  assert.equal(result.items.length, 1); assert.equal(result.next, 32); assert.equal(result.total, 100); assert.equal(result.totalIsPostCount, true);
  assert.equal(new URL(calls[0].url).searchParams.get('search'), 'A & B'); assert.equal(calls[0].init.credentials, 'omit');
  await assert.rejects(directSearch('', -1), /Invalid/);
  await assert.rejects(directSearch('', 0, { fetchImpl: async () => new Response('{}', { headers: { 'Content-Length': '9000000' } }) }), /size/);
});
test('Comic submission resolves only normal trusted HEAD redirects and never downloads archive bytes', async () => {
  const calls = [], fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET' });
    if (String(url).includes('/wp-json/')) return new Response(JSON.stringify(comic));
    assert.equal(init.method, 'HEAD'); assert.equal(init.redirect, 'manual');
    if (String(url).includes('/dls/')) return new Response(null, { status: 302, headers: { Location: 'https://fs3.comicfiles.ru/file.cbz' } });
    return new Response(null, { headers: { 'Content-Length': '123456' } });
  };
  const file = await resolveGetComicsDownload(123, 0, { fetchImpl, expectedUrl: comic.content.rendered.match(/href="([^"]+)/)[1].replace('http:', 'https:') });
  assert.equal(file.url, 'https://fs3.comicfiles.ru/file.cbz'); assert.deepEqual(calls.map((c) => c.method), ['GET', 'HEAD', 'HEAD']);
  await assert.rejects(resolveGetComicsDownload(123, 0, { fetchImpl, expectedUrl: 'https://getcomics.org/dls/changed' }), /changed/);
  await assert.rejects(resolveGetComicsDownload(123, 20, { fetchImpl }), /selection/);
  await assert.rejects(resolveGetComicsDownload(123, 0, { fetchImpl: async (url) => String(url).includes('/wp-json/')
    ? new Response(JSON.stringify(comic)) : new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/private' } }) }), /Unsupported/);
});
