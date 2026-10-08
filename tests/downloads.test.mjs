import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from '../vendor/fflate.js';
import { safeFilename, chapterCbz, readDownloadBytes, saveRemoteFile } from '../js/downloads.js';
import { mapDownloads } from '../js/sources/archive.js';
import { mapRecord } from '../js/sources/anna.js';
import { torrentUrl, matchingTorboxFiles } from '../js/sources/anna-downloads.js';
import { createTorboxClient } from '../server/torbox.mjs';
import { submitAnnaTorrent } from '../server/anna-downloads.mjs';

test('Download filenames remove paths, control characters, bidi tricks and reserved device names', () => {
  assert.equal(safeFilename('../Book/Chapter\u202e', 'cbz'), '-Book-Chapter-.cbz');
  assert.equal(safeFilename('CON.txt'), '_CON.txt');
  assert.equal(safeFilename('Already.CBZ', 'cbz'), 'Already.CBZ');
});
test('Chapter CBZ downloads preserve image order and escape credits without uploading files', async () => {
  const progress = [];
  const archive = await chapterCbz(['https://images.example/1', 'https://images.example/2'], {
    title: 'A & B', credits: '<credit>', onProgress: (p) => progress.push(p.pages),
    fetchImpl: async (url) => new Response(new Uint8Array([0xff, 0xd8, url.endsWith('1') ? 1 : 2])),
  });
  const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  assert.equal(files['0001.jpg'][2], 1); assert.equal(files['0002.jpg'][2], 2);
  assert.match(new TextDecoder().decode(files['ComicInfo.xml']), /A &amp; B/);
  assert.match(new TextDecoder().decode(files['ComicInfo.xml']), /&lt;credit&gt;/);
  assert.deepEqual(progress, [1, 2]);
});
test('Downloads reject excessive bodies, empty data, invalid schemes and HTML masquerading as images', async () => {
  await assert.rejects(readDownloadBytes('https://example.com', { maxBytes: 3, fetchImpl: async () => new Response('1234') }), /limit/);
  await assert.rejects(readDownloadBytes('javascript:alert(1)'), /Invalid/);
  await assert.rejects(readDownloadBytes('https://example.com', { fetchImpl: async () => new Response('') }), /empty/);
  await assert.rejects(chapterCbz(['https://example.com'], { fetchImpl: async () => new Response('<html>blocked</html>') }), /non-image/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(chapterCbz(['https://example.com'], { signal: controller.signal }), /abort/i);
});
test('Large remote files stream directly into a chosen file without an in-memory limit or navigation', async () => {
  const writes = [], progress = []; let closed = false, aborted = false;
  const size = await saveRemoteFile('https://cdn.example/archive.cbz', '../archive.cbz', {
    picker: async (options) => { assert.equal(options.suggestedName, '-archive.cbz'); return { createWritable: async () => ({
      write: async (bytes) => writes.push([...bytes]), close: async () => { closed = true; }, abort: async () => { aborted = true; },
    }) }; },
    fetchImpl: async (url, init) => {
      assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer');
      return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close(); } }),
        { headers: { 'Content-Length': String(500 * 1024 * 1024) } });
    }, onProgress: (n) => progress.push(n), save: () => assert.fail('The streamed file must not create a blob.'),
  });
  assert.equal(size, 3); assert.deepEqual(writes, [[1, 2], [3]]); assert.deepEqual(progress, [2, 3]); assert.equal(closed, true); assert.equal(aborted, false);
});
test('Cancelled or failed streamed files abort the pending save instead of keeping a corrupt partial file', async () => {
  for (const failure of ['empty', 'http', 'cancel']) {
    let aborted = false, closed = false; const controller = new AbortController();
    await assert.rejects(saveRemoteFile('https://cdn.example/archive.cbz', 'archive.cbz', {
      signal: controller.signal, picker: async () => ({ createWritable: async () => ({ write: async () => {},
        close: async () => { closed = true; }, abort: async () => { aborted = true; } }) }),
      fetchImpl: async () => new Response(failure === 'empty' ? '' : 'bytes', { status: failure === 'http' ? 403 : 200 }),
      onProgress: () => controller.abort(),
    }), failure === 'cancel' ? /abort/i : failure === 'empty' ? /empty/ : /403/);
    assert.equal(aborted, true); assert.equal(closed, false);
  }
  let fetched = false;
  await assert.rejects(saveRemoteFile('https://cdn.example/archive.cbz', 'archive.cbz', { picker: async () => { throw new DOMException('Picker cancelled', 'AbortError'); },
    fetchImpl: async () => { fetched = true; } }), /cancelled/);
  assert.equal(fetched, false);
});
test('Browsers without a file picker use bounded same-origin blob saves without external navigation', async () => {
  let saved;
  await saveRemoteFile('https://cdn.example/file.txt', 'file.txt', { picker: null, fetchImpl: async () => new Response('fixture'),
    save: (blob, filename) => { saved = { blob, filename }; } });
  assert.equal(saved.filename, 'file.txt'); assert.equal(await saved.blob.text(), 'fixture');
  await assert.rejects(saveRemoteFile('https://cdn.example/large.cbz', 'large.cbz', { picker: null,
    fetchImpl: async () => new Response('tiny', { headers: { 'Content-Length': String(500 * 1024 * 1024) } }), save: () => assert.fail('Oversized file saved') }), /limit/);
});
test('Archive download choices omit private files, restricted items and path traversal', () => {
  const metadata = { files: [{ name: 'public.pdf', size: '12' }, { name: 'private.epub', private: 'true' }, { name: '../escape.cbz' }, { name: 'image.jpg' }] };
  assert.deepEqual(mapDownloads('comic id', metadata), [{ name: 'public.pdf', size: 12, format: 'PDF', url: 'https://archive.org/download/comic%20id/public.pdf' }]);
  assert.deepEqual(mapDownloads('id', { ...metadata, metadata: { 'access-restricted-item': 'true' } }), []);
});
test('Anna metadata retains safe torrent mappings and matches files by hash or mapped path, not title guesses', () => {
  const id = '0123456789abcdef0123456789abcdef';
  const entry = mapRecord({ id, file_unified_data: { title_best: 'Book', extension_best: 'pdf' }, additional: { torrent_paths: [
    { collection: 'public', torrent_path: 'external/sample.torrent', file_level1: 'folder/book.pdf', file_level2: '' },
    { torrent_path: '../unsafe.torrent' }, { torrent_path: 'https://evil.example/unsafe.torrent' },
  ] } });
  assert.equal(entry.torrents.length, 1);
  assert.equal(torrentUrl(entry.torrents[0].path), 'https://annas-archive.pk/dyn/small_file/torrents/external/sample.torrent');
  const matches = matchingTorboxFiles(entry, [{ id: 1, kind: 'torrents', ready: true, files: [
    { id: 1, name: `data/${id}` }, { id: 2, name: 'root/folder/book.pdf' }, { id: 3, name: 'Unrelated Book.pdf' },
  ] }]);
  assert.deepEqual(matches.map((file) => file.id), [1, 2]);
  assert.throws(() => torrentUrl('/absolute.torrent'), /Invalid/);
});
test('Combined dump torrent classifications are retained without guessing file paths or duplicating richer mappings', () => {
  const entry = mapRecord({ _id: 'md5:0123456789abcdef0123456789abcdef', _source: {
    file_unified_data: { title_best: 'Book', classifications_unified: { torrent: [
      'external/rich.torrent', 'external/record-reference.torrent', 'external/record-reference.torrent',
      '../unsafe.torrent', 'https://evil.example/file.torrent', 42, null,
    ] } }, additional: { torrent_paths: [{ torrent_path: 'external/rich.torrent', collection: 'Known collection', file_level1: 'actual.pdf' }] },
  } });
  assert.deepEqual(entry.torrents, [
    { path: 'external/rich.torrent', collection: 'Known collection', file: 'actual.pdf', packedFile: '' },
    { path: 'external/record-reference.torrent', collection: '', file: '', packedFile: '' },
  ]);
  assert.equal(matchingTorboxFiles(entry, [{ id: 1, kind: 'torrents', ready: true, files: [{ id: 1, name: 'Book.pdf' }] }]).length, 0);
  const indexedOnly = mapRecord({ id: 'only-indexed', title: 'Indexed only', classifications_unified: { torrent: ['external/sample.torrent'] }, torrent_paths: {} });
  assert.equal(indexedOnly.torrents[0].path, 'external/sample.torrent');
});

test('TorBox torrent submission keeps credentials server-side and uses a bounded multipart file', async () => {
  const client = createTorboxClient('private-test-key', { fetchImpl: async (url, init) => {
    assert.equal(new URL(url).pathname, '/v1/api/torrents/createtorrent');
    assert.equal(new URL(url).search, ''); assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer private-test-key');
    assert.equal(init.body.get('seed'), '3', 'TorBox documents 3 as no seeding.'); assert.equal(init.body.get('as_queued'), 'true');
    assert.equal(init.body.get('allow_zip'), 'false'); assert.equal(await init.body.get('file').text(), 'public torrent');
    return new Response(JSON.stringify({ success: true, data: { torrent_id: 42 } }));
  } });
  assert.equal(await client.addTorrent(new TextEncoder().encode('public torrent')), 42);
});
test('Submitting an Anna torrent requires a matching inspected hash before any account mutation', async () => {
  let submissions = 0;
  const torrent = Buffer.from('d4:infod6:lengthi12e4:name5:a.txt12:piece lengthi16e6:pieces20:12345678901234567890ee');
  await assert.rejects(submitAnnaTorrent({ addTorrent: () => { submissions++; } }, 'external/sample.torrent', '0'.repeat(40), {
    fetchImpl: async () => new Response(torrent),
  }), /changed/);
  assert.equal(submissions, 0);
});
