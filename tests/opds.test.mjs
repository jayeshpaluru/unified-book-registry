import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFeed, formatOfType, pseUrl } from '../js/sources/opds.js';
import { parseXml } from './helpers/xml-shim.mjs';

const BASE = 'https://komga.example.com/opds/v1.2/catalog';
const feed = parseFeed(parseXml(readFileSync(new URL('./fixtures/opds-feed.xml', import.meta.url), 'utf8')), BASE);

test('feed title and next link are resolved', () => {
  assert.equal(feed.title, 'Komga & Friends');
  assert.equal(feed.next, 'https://komga.example.com/opds/v1.2/series?page=1');
  assert.equal(feed.entries.length, 3);
});

test('navigation entries expose a resolved nav link and no acquisitions', () => {
  const [nav] = feed.entries;
  assert.equal(nav.title, 'All series');
  assert.equal(nav.nav, 'https://komga.example.com/opds/v1.2/series');
  assert.deepEqual(nav.acquisitions, []);
  assert.equal(nav.pse, null);
});

test('acquisition entries expose formats, author, thumbnail and PSE stream', () => {
  const book = feed.entries[1];
  assert.equal(book.author, 'Jane Artist');
  assert.equal(book.summary, 'First issue.');
  assert.equal(book.thumb, 'https://komga.example.com/api/v1/books/1/thumbnail');
  assert.deepEqual(book.acquisitions.map((a) => [a.format, a.href]), [['cbz', 'https://komga.example.com/api/v1/books/1/file/issue1.cbz']]);
  assert.equal(book.nav, null);
  assert.equal(book.pse.count, 24);
  assert.equal(pseUrl(book.pse.template, 3), 'https://komga.example.com/api/v1/books/1/pages/3?zero_based=true');
});

test('open-access acquisition links count; unsupported formats map to null', () => {
  const novel = feed.entries[2];
  assert.deepEqual(novel.acquisitions.map((a) => a.format), ['epub', null]);
});

test('formatOfType', () => {
  assert.equal(formatOfType('application/vnd.comicbook+zip'), 'cbz');
  assert.equal(formatOfType('application/pdf'), 'pdf');
  assert.equal(formatOfType('application/x-cbr'), null);
});
