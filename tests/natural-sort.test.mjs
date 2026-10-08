import test from 'node:test';
import assert from 'node:assert/strict';
import { naturalCompare } from '../js/util.js';
import { pageNames } from '../js/pages.js';

test('naturalCompare orders numbers numerically', () => {
  const sorted = ['page10.jpg', 'page2.jpg', 'page1.jpg', 'page20.jpg'].sort(naturalCompare);
  assert.deepEqual(sorted, ['page1.jpg', 'page2.jpg', 'page10.jpg', 'page20.jpg']);
});

test('naturalCompare is case-insensitive and handles folders', () => {
  const sorted = ['b/2.png', 'B/10.png', 'a/1.png'].sort(naturalCompare);
  assert.deepEqual(sorted, ['a/1.png', 'b/2.png', 'B/10.png']);
});

test('pageNames filters junk and sorts naturally', () => {
  const names = [
    '__MACOSX/', '__MACOSX/._page1.jpg', '.DS_Store', 'ch1/', 'ch1/.hidden.png', 'ch1/ComicInfo.xml',
    'ch1/page10.jpg', 'ch1/page2.JPG', 'Thumbs.db', 'ch1/page1.png',
  ];
  assert.deepEqual(pageNames(names), ['ch1/page1.png', 'ch1/page2.JPG', 'ch1/page10.jpg']);
});
