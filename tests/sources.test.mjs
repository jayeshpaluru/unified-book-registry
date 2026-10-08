import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as archive from '../js/sources/archive.js';
import * as gutendex from '../js/sources/gutendex.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('IA search response maps to items with covers and paging', () => {
  const r = archive.mapSearch(fixture('ia-search.json'));
  assert.equal(r.total, 1163);
  assert.equal(r.hasMore, true);
  assert.equal(r.items.length, 4);
  assert.deepEqual(r.items[2], {
    id: 'atomic-war-01', title: 'Atomic War Issue #1 (Ace Comics)', year: 1952,
    cover: 'https://archive.org/services/img/atomic-war-01',
  });
  assert.equal(r.items[0].year, null);
});

test('IA search URL restricts to the public-domain collections and escapes input', () => {
  const url = new URL(archive.searchUrl('Captain "Marvel" (1)', 2));
  const q = url.searchParams.get('q');
  assert.match(q, /collection:\(fawcett-comics OR /);
  assert.match(q, /title:\(Captain AND Marvel AND 1\)/);
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('output'), 'json');
  assert.equal(url.searchParams.get('sort[]'), null);
  assert.equal(new URL(archive.searchUrl('')).searchParams.get('sort[]'), 'downloads desc');
});

test('IIIF manifest maps to page image URLs', () => {
  const { pages, rtl } = archive.mapManifest(fixture('ia-manifest.json'));
  assert.equal(pages.length, 3);
  assert.match(pages[0], /^https:\/\/iiif\.archive\.org\/image\/iiif\/3\/.*_0000\.jp2\/full\/max\/0\/default\.jpg$/);
  assert.equal(rtl, false);
  assert.equal(archive.mapManifest({ items: [], viewingDirection: 'right-to-left' }).rtl, true);
});

test('Gutendex response maps to books', () => {
  const r = gutendex.mapSearch(fixture('gutendex-search.json'));
  assert.equal(r.total, 166);
  assert.equal(r.next, 'https://gutendex.com/books/?copyright=false&page=2&search=holmes');
  assert.equal(r.items.length, 3);
  const [b] = r.items;
  assert.equal(typeof b.id, 'number');
  assert.equal(b.readUrl, `https://www.gutenberg.org/ebooks/${b.id}`);
  assert.match(b.cover, /^https:\/\/www\.gutenberg\.org\/.*\.jpg$/);
  assert.match(b.epubUrl, /epub/);
  assert.doesNotMatch(b.author, /,/); // "Last, First" is flipped
});

test('Gutendex search URL keeps the CORS-safe trailing slash', () => {
  const url = gutendex.searchUrl(' dracula ');
  assert.match(url, /^https:\/\/gutendex\.com\/books\/\?/);
  assert.match(url, /search=dracula/);
  assert.match(url, /copyright=false/);
});
