import test from 'node:test';
import assert from 'node:assert/strict';
import { createTorboxClient, metadataFiles, inspectMetadataAvailability, probeTorboxDownload } from '../server/torbox.mjs';

test('TorBox API credentials stay server-side and are never echoed in errors', async () => {
  const client = createTorboxClient('private-test-key', { fetchImpl: async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer private-test-key');
    assert.equal(new URL(url).origin, 'https://api.torbox.app');
    return new Response('private-test-key in upstream error', { status: 401 });
  } });
  await assert.rejects(client.account(), { message: 'TorBox returned HTTP 401.' });
});

test('TorBox list paging and metadata discovery do not confuse book files with metadata', async () => {
  const client = createTorboxClient('private-test-key', { fetchImpl: async () => new Response(JSON.stringify({ success: true, data: [
    { id: 12, download_finished: true, files: [{ id: 2, name: 'elasticsearch/aarecords__0.json.gz', size: 100 }, { id: 3, name: 'book.pdf' }] },
  ] })) });
  assert.deepEqual(metadataFiles(await client.list()), [{ kind: 'torrents', id: 12, fileId: 2,
    name: 'elasticsearch/aarecords__0.json.gz', size: 100, ready: true }]);
});

test('TorBox rejects links containing the API key and validates file references', async () => {
  const client = createTorboxClient('private-test-key', { fetchImpl: async () => new Response(JSON.stringify({ data:
    'https://cdn.example/book?token=private-test-key' })) });
  await assert.rejects(client.download('torrents', 1, 0), /unsafe download/);
  await assert.rejects(client.download('invalid', 1, 0), /Invalid TorBox/);
  await assert.rejects(client.download('torrents', -1, 0), /Invalid TorBox/);
});
test('Comic web downloads submit a resolved file through the server-only TorBox API without exposing its key', async () => {
  const calls = [], client = createTorboxClient('private-test-key', { fetchImpl: async (url, init) => {
    calls.push({ url, init }); return new Response(JSON.stringify({ success: true, data: { webdownload_id: 42 } }));
  } });
  assert.equal(await client.addWebDownload('https://fs3.comicfiles.ru/fixture.cbz'), 42);
  assert.equal(new URL(calls[0].url).pathname, '/v1/api/webdl/createwebdownload');
  assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.body.get('link'), 'https://fs3.comicfiles.ru/fixture.cbz');
  assert.equal(calls[0].init.body.get('as_queued'), 'false', 'A selected comic starts normally instead of waiting in the hourly queue.');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer private-test-key'); assert.doesNotMatch(String(calls[0].url), /private-test-key/);
  await assert.rejects(client.addWebDownload('http://files.example/x'), /Invalid/);
  await assert.rejects(client.addWebDownload('https://user:pass@files.example/x'), /Invalid/);
  await assert.rejects(client.addWebDownload('https://api.torbox.app/x'), /Invalid/);
  assert.equal(calls.length, 1);
});

test('Count-only Anna discovery covers Web Downloads and Usenet without exposing account data', async () => {
  const calls = [];
  const result = await inspectMetadataAvailability({ list: async (kind) => {
    calls.push(kind);
    if (kind === 'usenet') throw new Error('private-test-key and private account details');
    return [{ kind, id: 123, download_finished: kind === 'webdl', files: [
      { id: 7, name: 'private/path/aarecords__0.json.gz', size: 100 },
      { id: 8, name: 'private-book.pdf', size: 100 },
    ] }];
  } });
  assert.deepEqual(calls, ['torrents', 'webdl', 'usenet']);
  assert.deepEqual(result, { ready: 1, collections: [
    { kind: 'torrents', status: 'checked', ready: 0 },
    { kind: 'webdl', status: 'checked', ready: 1 },
    { kind: 'usenet', status: 'unavailable', ready: null },
  ] });
  assert.doesNotMatch(JSON.stringify(result), /private|aarecords|123/);
});

test('Failed collection checks report unknown availability rather than an empty account', async () => {
  const result = await inspectMetadataAvailability({ list: async () => { throw new Error('private upstream error'); } });
  assert.equal(result.ready, 0);
  assert.ok(result.collections.every((collection) => collection.status === 'unavailable' && collection.ready === null));
});

test('Read-only link probe selects a ready file privately and returns no names or numeric references', async () => {
  const calls = [];
  const result = await probeTorboxDownload({
    list: async (kind) => { calls.push(['list', kind]); return [
      { id: 90, download_finished: true, download_present: false, files: [{ id: 0, size: 8192 }] },
      { id: 91, download_finished: false, files: [{ id: 0, size: 8192 }] },
      { id: 123, name: 'private-download-name', download_present: true, files: [
        { id: 2, name: 'private-small-file', size: 100 }, { id: null, size: 8192 },
        { id: 3, name: 'private-file-name', size: '8192' },
      ] },
    ]; },
    download: async (...args) => { calls.push(['download', ...args]); return 'https://cdn.example/opaque-link'; },
  }, 'webdl');
  assert.deepEqual(calls, [['list', 'webdl'], ['download', 'webdl', 123, 3]]);
  assert.deepEqual(result, { url: 'https://cdn.example/opaque-link', kind: 'webdl', fileSize: 8192 });
  assert.doesNotMatch(JSON.stringify(result), /private|123|fileId|name/);
});

test('Read-only link probe fails safely on invalid collections and no usable files', async () => {
  let calls = 0;
  const client = { list: async () => { calls++; return []; }, download: async () => { assert.fail('No file should be requested.'); } };
  await assert.rejects(probeTorboxDownload(client, 'invalid'), /Invalid TorBox collection/);
  assert.equal(calls, 0);
  await assert.rejects(probeTorboxDownload(client), /No ready TorBox file/);
  assert.equal(calls, 1);
});
