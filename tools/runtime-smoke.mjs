// End-to-end check through your authenticated gh CLI; never prints private file names or URLs.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { webcrypto } from 'node:crypto';
import { openSealedResult, to64 } from '../js/sources/github-jobs.js';
const exec = promisify(execFile);
const repo = 'jayeshpaluru/unified-book-registry';
const keys = await webcrypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['encrypt', 'decrypt']);
const publicKey = to64(await webcrypto.subtle.exportKey('spki', keys.publicKey));
const id = `${Date.now()}-${webcrypto.randomUUID()}`;
await exec('gh', ['api', '--method', 'POST', `repos/${repo}/actions/workflows/runtime.yml/dispatches`,
  '-f', 'ref=main', '-f', `inputs[request_id]=${id}`, '-f', 'inputs[path]=torbox/list', '-f', 'inputs[params]={"kind":"torrents"}', '-f', `inputs[public_key]=${publicKey}`]);
console.log(`Dispatched encrypted TorBox runtime check: ${id}`);
const deadline = Date.now() + 8 * 60 * 1000;
while (Date.now() < deadline) {
  let response;
  try { response = JSON.parse((await exec('gh', ['api', `repos/${repo}/contents/requests/${id}.json?ref=runtime-results`])).stdout); }
  catch (error) { if (!String(error.stderr).includes('404')) throw new Error('Runtime result could not be read.'); }
  if (response) {
    const envelope = JSON.parse(Buffer.from(response.content, 'base64').toString());
    const result = await openSealedResult(envelope, keys.privateKey);
    if (result.requestId !== id || result.error) throw new Error(result.error || 'Response identity mismatch.');
    console.log(`Live runtime passed: ${result.data.items.length} TorBox downloads returned through an encrypted response. Private names and links withheld.`);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
if (Date.now() >= deadline) throw new Error('Live runtime check timed out. Inspect the existing workflow run before retrying.');
