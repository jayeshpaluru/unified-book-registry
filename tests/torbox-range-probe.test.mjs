import test from 'node:test';
import assert from 'node:assert/strict';
import { probeTorboxRange } from '../tools/torbox-range-probe.mjs';

const headers = { 'Content-Range': 'bytes 0-4095/8192', 'Content-Length': '4096' };
test('Private range probe requests only 4 KiB without credentials and returns only proof metrics', async () => {
  const proof = await probeTorboxRange('https://cdn.example/private-url', 8192, { fetchImpl: async (url, init) => {
    assert.equal(url, 'https://cdn.example/private-url');
    assert.deepEqual(init.headers, { Range: 'bytes=0-4095' });
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.mode, 'cors');
    return new Response(new Uint8Array(4096), { status: 206, headers });
  } });
  assert.deepEqual(proof, { status: 206, bytes: 4096, rangeExposed: true, totalMatched: true });
});

test('Range probe cancels full-file fallback or hidden, compressed, wrong-size ranges without reading bodies', async () => {
  for (const [status, extra, expected] of [
    [200, headers, /HTTP 200/], [206, {}, /Content-Range/],
    [206, { ...headers, 'Content-Range': 'bytes 0-4095/9999' }, /Content-Range/],
    [206, { ...headers, 'Content-Encoding': 'gzip' }, /compressed/],
    [206, { ...headers, 'Content-Length': '8192' }, /length/],
  ]) {
    let cancelled = false, reads = 0;
    const response = { status, headers: new Headers(extra), body: {
      cancel: async () => { cancelled = true; }, getReader: () => { reads++; assert.fail('Rejected response body must not be read.'); },
    } };
    await assert.rejects(probeTorboxRange('https://cdn.example/private-url', 8192, { fetchImpl: async () => response }), expected);
    assert.equal(cancelled, true); assert.equal(reads, 0);
  }
});

test('Range probe enforces its byte budget, rejects truncation and sanitizes fetch errors', async () => {
  for (const bytes of [2000, 4097]) {
    await assert.rejects(probeTorboxRange('https://cdn.example/private-url', 8192, { fetchImpl: async () =>
      new Response(new Uint8Array(bytes), { status: 206, headers }) }), bytes < 4096 ? /incomplete/ : /4 KiB/);
  }
  await assert.rejects(probeTorboxRange('https://cdn.example/private-url', 8192, { fetchImpl: async () => {
    throw new Error('private-url private filename private API key');
  } }), { message: 'The temporary TorBox link could not be fetched from the Pages origin.' });
});
