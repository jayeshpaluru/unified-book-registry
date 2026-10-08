import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKatanaSeries, parseKatanaChapters, parseKatanaPages, KATANA_SERIES_ID, KATANA_CHAPTER_ID } from '../server/mangakatana.mjs';
import { createPublicReaderClient } from '../server/public-readers.mjs';

const series = '<div id="book_list"><div class="item"><a href="/manga/one-piece.49"><img src="/imgs/cover/one-piece.jpg" alt="[Cover]"></a>' +
  '<h3><a href="/manga/one-piece.49">One Piece &amp; Friends</a></h3></div></div><div id="hot_book"><a href="/manga/sidebar.99">Not a search result</a></div>';
const chapters = '<a href="/manga/one-piece.49/c10">Chapter 10: Ten</a><a href="/manga/one-piece.49/c2.5">Chapter 2.5: Half</a>' +
  '<a href="/manga/one-piece.49/c2">Chapter 2: Two</a><a href="/manga/one-piece.49/c2">Chapter 2</a><a href="/manga/other-book.50/c1">Chapter 1: Unrelated</a>';
const manifest = `<script>var thzq=['https://i1.mangakatana.com/token/public/1.jpg','https://i1.mangakatana.com/token/public/2.jpg',];</script>`;

test('MangaKatana directories isolate factual search results from sidebar recommendations and preserve separate cover anchors', () => {
  const result = parseKatanaSeries(series);
  assert.equal(result.length, 1); assert.equal(result[0].title, 'One Piece & Friends'); assert.equal(result[0].id, 'one-piece.49');
  assert.equal(result[0].cover, 'https://mangakatana.com/imgs/cover/one-piece.jpg'); assert.equal(result[0].source, 'mangakatana');
  assert.deepEqual(parseKatanaSeries('<div id="book_list"></div>'), []);
  assert.throws(() => parseKatanaSeries('<a href="/manga/one-piece.49">Unscoped title</a>'), /markup/);
  assert.equal(parseKatanaSeries('<div id="book_list"><a href="https://evil.example/manga/one-piece.49">Foreign</a><script><a href="/manga/one-piece.49">Script</a></script></div>').length, 0);
});
test('MangaKatana chapters bind to the selected series, retain chapter subtitles and sort decimal numbers', () => {
  const result = parseKatanaChapters(chapters, 'one-piece.49');
  assert.deepEqual(result.map((c) => c.chapter), ['2', '2.5', '10']); assert.equal(result[0].id, 'one-piece.49~c2');
  assert.equal(result[0].title, 'Two'); assert.deepEqual(result[0].groups, []);
  assert.throws(() => parseKatanaChapters(chapters, '../one-piece.49'), /Invalid/);
  for (const id of ['one-piece.49', 'example-123.1']) assert.equal(KATANA_SERIES_ID.test(id), true);
  for (const id of ['../one-piece.49', 'https://evil.example/x', 'a'.repeat(221) + '.1']) assert.equal(KATANA_SERIES_ID.test(id), false);
  assert.equal(KATANA_CHAPTER_ID.test('one-piece.49~c2.5'), true); assert.equal(KATANA_CHAPTER_ID.test('one-piece.49~../../private'), false);
});
test('MangaKatana page manifests parse literal URLs without executing code or rewriting anonymous tokens', () => {
  assert.deepEqual(parseKatanaPages(manifest).pages, ['https://i1.mangakatana.com/token/public/1.jpg', 'https://i1.mangakatana.com/token/public/2.jpg']);
  const duplicate = `var thzq=['https://i1.mangakatana.com/1.jpg','https://i1.mangakatana.com/1.jpg'];`;
  assert.equal(parseKatanaPages(duplicate).pages.length, 2, 'A literal page sequence retains repeated pages in its original order.');
  for (const data of [`var thzq=[run('https://i1.mangakatana.com/1.jpg')];`, `var thzq=['https://evil.example/page.jpg'];`,
    `var thzq=['https://user:pass@i1.mangakatana.com/1.jpg'];`, `var thzq=['http://i1.mangakatana.com/1.jpg'];`, `var thzq=[];`]) {
    assert.throws(() => parseKatanaPages(data), /manifest|host|URL/);
  }
  assert.throws(() => parseKatanaPages('var thzq=[' + Array.from({ length: 2001 }, (_, i) => `'https://i1.mangakatana.com/${i}.jpg'`).join(',') + '];'), /too many/);
});
test('Anonymous MangaKatana metadata requests use real directory/search paths, cache metadata, validate IDs and paginate chapters', async () => {
  const calls = [], client = createPublicReaderClient({ fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    return new Response(String(url).includes('/c2') ? manifest : String(url).includes('/manga/one-piece.49') ? chapters
      : series + '<a class="next page-numbers" href="/manga/page/2?order=latest">Next</a>');
  } });
  assert.equal((await client.search('mangakatana', '', 1)).next, 2);
  assert.equal(calls[0].url.pathname, '/manga/'); assert.equal(calls[0].url.searchParams.get('order'), 'latest');
  await client.search('mangakatana', '', 2); assert.equal(calls[1].url.pathname, '/manga/page/2');
  await client.search('mangakatana', 'One Piece', 2); assert.equal(calls[2].url.pathname, '/page/2');
  assert.equal(calls[2].url.searchParams.get('search'), 'One Piece'); assert.equal(calls[2].url.searchParams.get('search_by'), 'book_name');
  const feed = await client.chapters('mangakatana', 'one-piece.49'); assert.equal(feed.total, 3); assert.equal(feed.items[0].id, 'one-piece.49~c2');
  assert.equal((await client.pages('mangakatana', 'one-piece.49~c2')).pages.length, 2);
  await client.pages('mangakatana', 'one-piece.49~c2'); assert.equal(calls.length, 5);
  assert.ok(calls.every((c) => c.url.origin === 'https://mangakatana.com' && !c.init.headers.Authorization && c.init.redirect === 'manual'));
  await assert.rejects(client.pages('mangakatana', '../private'), /Invalid/); assert.equal(calls.length, 5);
});
