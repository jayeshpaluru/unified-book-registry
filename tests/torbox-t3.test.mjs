import test from 'node:test';
import assert from 'node:assert/strict';
import { createTorboxT3, probeTorboxT3 } from '../server/torbox-t3.mjs';

const bucketXml = '<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Buckets><Bucket><Name>torbox</Name></Bucket></Buckets></ListAllMyBucketsResult>';
const fileXml = '<ListBucketResult><EncodingType>url</EncodingType><Contents><Key>private%2Ffile%20%26%20one.sqlite</Key><Size>8192</Size></Contents></ListBucketResult>';
test('T3 presigned GET matches the published S3 v2 query-signature vector without exposing its secret', () => {
  // AWS's original johnsmith example, before its bucket name was anonymized.
  const key = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const client = createTorboxT3('AKIAIOSFODNN7EXAMPLE', key, { now: () => (1175139620 - 1800) * 1000 });
  const url = new URL(client.download('johnsmith', 'photos/puppy.jpg'));
  assert.equal(url.origin, 'https://t3.nexus'); assert.equal(url.pathname, '/johnsmith/photos/puppy.jpg');
  assert.equal(url.searchParams.get('AWSAccessKeyId'), 'AKIAIOSFODNN7EXAMPLE');
  assert.equal(url.searchParams.get('Expires'), '1175139620');
  assert.equal(url.searchParams.get('Signature'), 'NpgCjnDzrM+WFzoENXmpNDUsSn8=');
  assert.ok(!decodeURIComponent(url.href).includes(key));
});

test('T3 read-only probe keeps account details and file references out of its result and sanitizes URLs', async () => {
  const calls = [];
  const result = await probeTorboxT3({ account: async () => ({ auth_id: 'private-auth-id', email: 'private@email.invalid', plan: 2 }) }, 'private-test-key', {
    now: () => 1700000000000,
    fetchImpl: async (value, init) => {
      const url = new URL(value); calls.push(url.pathname);
      assert.equal(url.origin, 'https://t3.nexus'); assert.equal(init.redirect, 'error');
      assert.ok(!decodeURIComponent(url.href).includes('private-test-key'));
      assert.ok(!init.method || init.method === 'GET');
      if (url.pathname === '/') return new Response(bucketXml);
      assert.equal(url.searchParams.get('max-keys'), '1000');
      assert.equal(url.searchParams.get('encoding-type'), 'url');
      return new Response(fileXml);
    },
  });
  assert.deepEqual(calls, ['/', '/torbox']);
  assert.deepEqual(Object.keys(result).sort(), ['fileSize', 'kind', 'url']);
  assert.equal(result.fileSize, 8192); assert.equal(result.kind, 't3');
  const url = new URL(result.url);
  assert.equal(url.pathname, '/torbox/private/file%20%26%20one.sqlite');
  assert.doesNotMatch(JSON.stringify(result), /private-test-key|email|plan|"key"|"bucket"/);
});

test('T3 signs encoded object paths literally and rejects unsafe references before making requests', () => {
  const client = createTorboxT3('fixture-auth-id', 'fixture-secret-key');
  const url = new URL(client.download('torbox', "Folder/日本語's #1?.sqlite"));
  assert.match(url.pathname, /Folder\/%E6%97%A5%E6%9C%AC%E8%AA%9E%27s%20%231%3F\.sqlite$/);
  for (const key of ['../private', './file', 'file/../../other', 'bad\\path', 'control\nfile', '']) {
    assert.throws(() => client.download('torbox', key), /Invalid T3|Select a T3/);
  }
  assert.throws(() => client.download('../other', 'file'), /Invalid T3 bucket/);
  assert.throws(() => createTorboxT3('fixture-secret-key', 'fixture-secret-key'), /valid Auth ID/);
});

test('T3 XML parsing decodes scalar entities but never expands DTDs, unknown entities or malformed file references', async () => {
  const fixtures = [
    ['<!DOCTYPE x [<!ENTITY name "private">]><ListBucketResult></ListBucketResult>', /invalid XML/],
    ['<ListBucketResult><Contents><Key>&unknown;</Key><Size>8192</Size></Contents></ListBucketResult>', /invalid XML value/],
    ['<ListBucketResult><Contents><Key>../private</Key><Size>8192</Size></Contents></ListBucketResult>', /Invalid T3 file/],
    ['<ListBucketResult><EncodingType>url</EncodingType><Contents><Key>%ZZ</Key><Size>8192</Size></Contents></ListBucketResult>', /invalid file/],
    ['<ListBucketResult><Contents><Key>file</Key><Size>9007199254740992</Size></Contents></ListBucketResult>', /invalid file/],
    ['<Error><Message>private failure</Message></Error>', /invalid file list/],
  ];
  for (const [body, message] of fixtures) {
    const client = createTorboxT3('fixture-auth-id', 'fixture-secret-key', { fetchImpl: async () => new Response(body) });
    await assert.rejects(client.files('torbox'), message);
  }
  const client = createTorboxT3('fixture-auth-id', 'fixture-secret-key', { fetchImpl: async () => new Response(
    '<ListBucketResult><Contents><Key>books/A &amp; B &#x65;&#112;ub</Key><Size>8192</Size></Contents></ListBucketResult>') });
  assert.deepEqual(await client.files('torbox'), [{ key: 'books/A & B epub', size: 8192 }]);
});

test('T3 rejects excessive lists and private upstream errors without echoing signed URLs or account data', async () => {
  const oversized = createTorboxT3('fixture-auth-id', 'fixture-secret-key', { fetchImpl: async () =>
    new Response('private-body', { headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } }) });
  await assert.rejects(oversized.buckets(), /excessive file list/);
  const denied = createTorboxT3('fixture-auth-id', 'fixture-secret-key', { fetchImpl: async () => new Response('fixture-secret-key', { status: 403 }) });
  await assert.rejects(denied.buckets(), { message: 'TorBox T3 returned HTTP 403.' });
  const unreachable = createTorboxT3('fixture-auth-id', 'fixture-secret-key', { fetchImpl: async () => { throw new Error('fixture-secret-key private URL'); } });
  await assert.rejects(unreachable.buckets(), { message: 'TorBox T3 could not be reached.' });
  let requests = 0;
  await assert.rejects(probeTorboxT3({ account: async () => ({ id: 'not-the-auth-id' }) }, 'fixture-secret-key', {
    fetchImpl: async () => { requests++; assert.fail('Missing Auth ID must not result in a T3 request.'); },
  }), /valid Auth ID/);
  assert.equal(requests, 0);
});

test('T3 diagnostic checks only existing objects and does not equate a bounded empty sample with full-account coverage', async () => {
  const calls = [];
  await assert.rejects(probeTorboxT3({ account: async () => ({ auth_id: 'fixture-auth-id' }) }, 'fixture-secret-key', {
    fetchImpl: async (url) => { calls.push(new URL(url).pathname); return new Response(calls.length === 1 ? bucketXml : '<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>'); },
  }), /bounded read-only T3 sample/);
  assert.deepEqual(calls, ['/', '/torbox']);
});
