import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { RangeReader } from '../js/index/range-reader.js';
import { searchStatements, indexManifest } from '../js/index/queries.js';
import { openAnnaStore } from '../server/anna-store.mjs';
import { exportAnnaIndex } from '../server/anna-index.mjs';
import { mapRecord } from '../js/sources/anna.js';
import { createHash } from 'node:crypto';

const plan = { snapshot: '20260208', hash: 'a'.repeat(40), files: Array.from({ length: 12 }, (_, shard) => ({ shard, index: shard + 1 })) };
test('Index export requires all selected shards, preserves the live source and FTS row IDs, and finalizes a self-describing snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ubr-index-fixture-'));
  const sourcePath = join(dir, 'source.sqlite'), source = openAnnaStore(sourcePath);
  try {
    source.put(mapRecord({ id: 'book', title: 'Range search fixture', author: 'Example author', isbn: ['9781234567890'] }));
    await assert.rejects(exportAnnaIndex({ sourcePath, plan, directory: join(dir, 'snapshots'), reserveBytes: 0n }), /All 12/);
    plan.files.forEach((file) => source.finishImport(`${plan.hash}:${file.index}`, 1));
    await assert.rejects(exportAnnaIndex({ sourcePath, plan, directory: join(dir, 'snapshots'), reserveBytes: 10n ** 18n }), /disk/);
    const edit = new DatabaseSync(sourcePath); edit.exec('UPDATE books SET rowid = 987'); edit.close();
    const { file, receipt } = await exportAnnaIndex({ sourcePath, plan, directory: join(dir, 'snapshots'), reserveBytes: 0n });
    assert.equal(source.search('Range').total, 1); assert.equal(source.total(), 1);
    const bytes = await readFile(file); assert.equal(bytes[18], 1); assert.equal(bytes[19], 1);
    const index = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(index.prepare('SELECT rowid FROM books').get().rowid, 987);
      assert.equal(index.prepare("SELECT count(*) AS n FROM books_fts WHERE books_fts MATCH 'Range'").get().n, 1);
      assert.equal(index.prepare("SELECT rowid FROM books_search_book WHERE books_search_book MATCH 'Range'").get().rowid, 987);
      assert.equal(index.prepare('SELECT count(*) AS n FROM books_search_comic').get().n, 0);
      assert.deepEqual(indexManifest(JSON.parse(index.prepare("SELECT value FROM anna_index_metadata WHERE key='manifest'").get().value)),
        Object.fromEntries(Object.entries(receipt).filter(([key]) => !['file', 'bytes', 'sha256'].includes(key))));
      assert.equal(receipt.complete, true); assert.equal(receipt.searchLayout, 'partitioned-fts-v1'); assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
      const live = new DatabaseSync(sourcePath, { readOnly: true });
      try { assert.equal(live.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'books_search_%'").get().n, 0); }
      finally { live.close(); }
    } finally { index.close(); }
  } finally { source.close(); await rm(dir, { recursive: true, force: true }); }
});
test('Partitioned index searches count and page exact matches without joining every metadata record, including sparse 64-bit row IDs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ubr-partition-fixture-'));
  const sourcePath = join(dir, 'source.sqlite'), source = openAnnaStore(sourcePath);
  try {
    source.begin();
    for (let n = 0; n < 95; n++) source.put(mapRecord({ id: `book-${n}`, title: `Common fixture ${n}`, author: 'Common Author' }));
    source.put(mapRecord({ id: 'comic', file_unified_data: { title_best: 'Common comic', author_best: 'Common Author', content_type_best: 'comic' } }));
    source.commit(); plan.files.forEach((file) => source.finishImport(`${plan.hash}:${file.index}`, 1));
    const edit = new DatabaseSync(sourcePath); edit.exec("UPDATE books SET rowid = 1000000000000000000 WHERE id = 'comic'"); edit.close();
    const { file, receipt } = await exportAnnaIndex({ sourcePath, plan, directory: join(dir, 'snapshots'), reserveBytes: 0n });
    const index = new DatabaseSync(file, { readOnly: true });
    try {
      const run = (type, offset = 0) => {
        const sql = searchStatements('Common Author', { type, offset, searchLayout: receipt.searchLayout });
        assert.doesNotMatch(sql.count, /JOIN/);
        return { total: index.prepare(sql.count).get(...sql.countArgs)['count(*)'],
          items: index.prepare(sql.rows).all(...sql.rowArgs).map(row => JSON.parse(row.data)) };
      };
      assert.equal(run().total, 96); assert.equal(run('book').total, 95);
      assert.equal(run('book').items.length, 30);
      assert.deepEqual(run('book', 90).items.map(item => item.id), ['book-90', 'book-91', 'book-92', 'book-93', 'book-94']);
      assert.deepEqual(run('comic').items.map(item => item.id), ['comic']);
      assert.deepEqual(run(undefined, 95).items.map(item => item.id), ['comic']);
      assert.equal(run('book', 100).items.length, 0);
    } finally { index.close(); }
  } finally { source.close(); await rm(dir, { recursive: true, force: true }); }
});
test('Search partitions are built in bounded batches and an interrupted export never produces a finalized receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ubr-index-batches-'));
  const sourcePath = join(dir, 'source.sqlite'), source = openAnnaStore(sourcePath);
  try {
    source.begin();
    for (let n = 0; n < 50001; n++) source.put({ id: `batch-${n}`, title: 'Batch fixture', author: 'Batch author', isbn: [], type: n % 2 ? 'comic' : 'book' });
    source.commit(); plan.files.forEach((file) => source.finishImport(`${plan.hash}:${file.index}`, 1));
    const interrupted = join(dir, 'interrupted');
    await assert.rejects(exportAnnaIndex({ sourcePath, plan, directory: interrupted, reserveBytes: 0n,
      onProgress: (progress) => { if (progress.stage === 'indexing') throw new Error('Fixture stop after a committed batch'); } }), /Fixture stop/);
    const [partialFolder] = await readdir(interrupted);
    assert.deepEqual(await readdir(join(interrupted, partialFolder)), ['anna-index.partial.sqlite']);
    assert.equal(source.total(), 50001);
    const progress = [];
    const { receipt } = await exportAnnaIndex({ sourcePath, plan, directory: join(dir, 'complete'), reserveBytes: 0n,
      onProgress: (value) => { if (value.stage === 'indexing') progress.push(value.indexed); } });
    assert.deepEqual(progress, [50000, 50001]);
    assert.deepEqual(receipt.counts, { book: 25001, comic: 25000 });
  } finally { source.close(); await rm(dir, { recursive: true, force: true }); }
});
test('Range reads are cached, bounded, support offsets above 4 GiB and never accept a full-file 200 response', async () => {
  let requests = 0; const total = 9_000_000_000;
  const reader = new RangeReader('https://files.example/index.sqlite', { expectedSize: total, fetchImpl: async (url, init) => {
    requests++; assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer');
    const [start, end] = init.headers.Range.slice(6).split('-').map(Number);
    return new Response(new Uint8Array(end - start + 1).fill(42), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${total}` } });
  } });
  assert.deepEqual([...await reader.read(4_294_967_300, 2)], [42, 42]);
  await reader.read(4_294_967_301, 2); assert.equal(requests, 1);
  reader.beginQuery({ maxRequests: 0 }); await assert.rejects(reader.read(0, 1), /budget/);
  let cancelled = false;
  const full = new RangeReader('https://files.example/index.sqlite', { fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  await assert.rejects(full.read(0, 100), /206/); assert.equal(cancelled, true);
  reader.close(); assert.equal(reader.url, ''); assert.equal(reader.cache.size, 0);
});
test('Range reads reject malformed/hidden headers, changed size, truncated bodies and unsafe URLs', async () => {
  assert.throws(() => new RangeReader('https://user:password@files.example/db'), /secure/);
  for (const headers of [{}, { 'Content-Range': 'bytes 1-99/100' }, { 'Content-Range': 'bytes 0-99/999' }]) {
    await assert.rejects(new RangeReader('https://files.example/db', { expectedSize: 100, fetchImpl: async () => new Response(new Uint8Array(100), { status: 206, headers }) }).read(0, 100), /Content-Range/);
  }
  await assert.rejects(new RangeReader('https://files.example/db', { fetchImpl: async () => new Response(new Uint8Array(99), { status: 206, headers: { 'Content-Range': 'bytes 0-99/100' } }) }).read(0, 100), /incomplete/);
});
test('Index search binds query/type/paging and never labels partial metadata as a complete snapshot', () => {
  const sql = searchStatements(' 978-1-234-56789-0 ', { type: 'comic', offset: 30 });
  assert.deepEqual(sql.countArgs, ['"9781234567890"*', 'comic']); assert.deepEqual(sql.rowArgs.slice(-2), [30, 30]);
  assert.equal(searchStatements('?!').empty, true);
  assert.throws(() => searchStatements('x', { type: 'comic OR 1=1' }), /Invalid/);
  assert.throws(() => searchStatements('x', { searchLayout: 'books; DROP TABLE books' }), /Invalid/);
  const partitioned = searchStatements('Example', { type: 'comic', searchLayout: 'partitioned-fts-v1' });
  assert.deepEqual(partitioned.countArgs, ['"Example"*']); assert.match(partitioned.count, /books_search_comic/);
  assert.match(searchStatements('Example', { searchLayout: 'partitioned-fts-v1' }).count, /FROM books_fts/);
  assert.equal(searchStatements('', { offset: 2 ** 32 }).rowArgs.at(-1), 2 ** 32);
  assert.throws(() => indexManifest({ format: 'ubr-anna-sqlite', version: 1, payload: 'metadata-only', complete: true,
    snapshot: plan.snapshot, infoHash: plan.hash, records: 1, counts: { book: 1, comic: 0 }, shards: [0] }), /verified/);
  assert.throws(() => indexManifest({ format: 'ubr-anna-sqlite', version: 1, payload: 'metadata-only', complete: false,
    snapshot: plan.snapshot, infoHash: plan.hash, records: 1, counts: { book: 1, comic: 0 }, shards: [0], searchLayout: 'unknown' }), /verified/);
});
test('Vendored full-text browser runtime matches its pinned public build receipt and carries the upstream license', async () => {
  const root = new URL('../vendor/wa-sqlite/', import.meta.url);
  const provenance = JSON.parse(await readFile(new URL('PROVENANCE.json', root), 'utf8'));
  for (const [file, expected] of Object.entries(provenance.sha256)) {
    const bytes = await readFile(new URL(file, root)); assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
  }
  assert.match(await readFile(new URL('LICENSE', root), 'utf8'), /MIT License/);
});
