import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { sealResult } from '../server/sealed-result.mjs';
import { openSealedResult, to64 } from '../js/sources/github-jobs.js';

test('Public runtime results decrypt only with the requesting browser’s non-exportable private key', async () => {
  const keys = await webcrypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['encrypt', 'decrypt']);
  const pub = to64(await webcrypto.subtle.exportKey('spki', keys.publicKey));
  const value = { requestId: 'request', data: { title: 'Private 日本語 title', url: 'https://cdn.example/private-signed-link' } };
  const envelope = sealResult(value, pub);
  assert.doesNotMatch(JSON.stringify(envelope), /Private|cdn\.example|signed-link/);
  assert.deepEqual(await openSealedResult(envelope, keys.privateKey), value);
  await assert.rejects(webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const changed = { ...envelope, data: envelope.data.slice(0, -4) + 'AAAA' };
  await assert.rejects(openSealedResult(changed, keys.privateKey));
  assert.throws(() => sealResult(value, 'not-a-key'), /Invalid session/);
});
