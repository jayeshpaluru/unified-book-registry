import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from '../vendor/fflate.js';
import { openArchive, readEntry } from '../js/zip.js';

const bytes = (...n) => new Uint8Array(n);

function tinyCbz() {
  return zipSync({
    '__MACOSX/._p1.jpg': bytes(9),
    '.hidden.jpg': bytes(9),
    'notes.txt': bytes(9),
    'p10.jpg': bytes(10),
    'p2.jpg': bytes(2),
    'p1.png': bytes(1),
  });
}

test('openArchive returns pages in natural order, skipping junk', () => {
  const { pages } = openArchive(tinyCbz());
  assert.deepEqual(pages, ['p1.png', 'p2.jpg', 'p10.jpg']);
});

test('page blobs hold the right bytes and mime type', async () => {
  const { blob } = openArchive(tinyCbz());
  const second = blob(1);
  assert.equal(second.type, 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await second.arrayBuffer())], [2]);
  assert.equal(blob(0).type, 'image/png');
});

test('readEntry extracts a single entry lazily', () => {
  assert.deepEqual([...readEntry(tinyCbz(), 'p10.jpg')], [10]);
});

test('archives without images are rejected', () => {
  assert.throws(() => openArchive(zipSync({ 'readme.txt': bytes(1) })), /No images/);
});
