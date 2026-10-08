import test from 'node:test';
import assert from 'node:assert/strict';
import { createTorboxClient, metadataFiles } from '../server/torbox.mjs';

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
