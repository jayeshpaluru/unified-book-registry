import test from 'node:test';
import assert from 'node:assert/strict';
import { parseComikey, parseWebtoon, plainText } from '../server/public-catalogs.mjs';
import { searchRecords } from '../js/sources/catalog-search.js';

test('Public publisher adapters preserve canonical links and do not treat paid catalogs as entirely free', () => {
  const ck = parseComikey('<li class="item-full-row item-preview"><img src="https://media.comikey.com/cover.jpg"><span class="title"><a href="https://comikey.com/comics/example-manga/10/">A &amp; B</a></span><span class="subtitle">by <a>Author</a></span></li>');
  assert.equal(ck.items[0].title, 'A & B'); assert.equal(ck.items[0].author, 'Author');
  assert.match(ck.items[0].summary, /paid/);
  const wt = parseWebtoon('<a class="link _originals_title_a" data-title-no="12" href="https://www.webtoons.com/en/fantasy/example/list?title_no=12"><img src="https://images.example/cover.jpg"><strong class="title">Example &#x65E5;</strong></a>');
  assert.equal(wt.items[0].title, 'Example 日'); assert.equal(wt.items[0].id, '12');
  assert.equal(plainText('<script>alert(1)</script><b>Safe</b>'), 'Safe');
});

test('Static catalog searches title, author, normalized ISBN and type with real pagination', () => {
  const records = [{ id: '1', title: 'Café 日本語', author: 'A Writer', isbn: ['9780521879286'], type: 'book' },
    { id: '2', title: 'A comic', author: 'A Writer', isbn: [], type: 'comic' }];
  assert.equal(searchRecords(records, 'cafe writer').total, 1);
  assert.equal(searchRecords(records, '978-0-521-87928-6').total, 1);
  assert.equal(searchRecords(records, '', { type: 'comic' }).items[0].id, '2');
  assert.equal(searchRecords(records, '', { limit: 1 }).next, 1);
  assert.equal(searchRecords(records, '', { offset: 1, limit: 1 }).next, null);
  assert.equal(searchRecords(records, '"*--').total, 0);
});
