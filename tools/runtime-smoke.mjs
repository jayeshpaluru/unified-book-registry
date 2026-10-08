// End-to-end check through your authenticated gh CLI; never prints private file names or URLs.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { webcrypto } from 'node:crypto';
import { openSealedResult, to64 } from '../js/sources/github-jobs.js';
const exec = promisify(execFile);
const repo = 'jayeshpaluru/unified-book-registry';
const publicOnly = process.argv.includes('--public');
const chapterPosition = process.argv.indexOf('--chapter');
const chapterId = chapterPosition >= 0 ? process.argv[chapterPosition + 1] : null;
if (chapterId && (!publicOnly || !/^[a-f\d]{8}-[a-f\d-]{27}$/.test(chapterId))) throw new Error('Chapter checks must use --public and a valid MangaDex chapter ID.');
const requestPath = chapterId ? `mangadex/chapter/${chapterId}/pages` : publicOnly ? 'mangadex/search' : 'torbox/list';
const keys = await webcrypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['encrypt', 'decrypt']);
const publicKey = to64(await webcrypto.subtle.exportKey('spki', keys.publicKey));
const id = `${Date.now()}-${webcrypto.randomUUID()}`;
await exec('gh', ['api', '--method', 'POST', `repos/${repo}/actions/workflows/runtime.yml/dispatches`,
  '-f', 'ref=main', '-f', `inputs[request_id]=${id}`, '-f', `inputs[path]=${requestPath}`,
  '-f', `inputs[params]=${chapterId ? '{}' : publicOnly ? '{"q":"Yotsuba","offset":0}' : '{"kind":"torrents"}'}`, '-f', `inputs[public_key]=${publicKey}`]);
console.log(`Dispatched encrypted ${publicOnly ? 'public catalog' : 'TorBox'} runtime check: ${id}`);
const deadline = Date.now() + 8 * 60 * 1000;
while (Date.now() < deadline) {
  let response;
  try { response = JSON.parse((await exec('gh', ['api', `repos/${repo}/contents/requests/${id}.json?ref=runtime-results`])).stdout); }
  catch (error) { if (!String(error.stderr).includes('404')) throw new Error('Runtime result could not be read.'); }
  if (response) {
    const envelope = JSON.parse(Buffer.from(response.content, 'base64').toString());
    const result = await openSealedResult(envelope, keys.privateKey);
    if (result.requestId !== id || result.error) throw new Error(result.error || 'Response identity mismatch.');
    if (chapterId) {
      const { chapter, baseUrl } = result.data;
      const url = `${baseUrl}/data/${encodeURIComponent(chapter.hash)}/${encodeURIComponent(chapter.data[0])}`;
      const page = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(30000) });
      if (!page.ok || !page.headers.get('content-type')?.startsWith('image/')) throw new Error('MangaDex image server could not serve the available chapter.');
      console.log(`Live chapter runtime passed: ${chapter.data.length} page references, first image HEAD ${page.status}. No chapter image body or TorBox account data downloaded.`);
    } else console.log(publicOnly ? `Live public-catalog runtime passed: ${result.data.data.length} MangaDex results through an encrypted response. No TorBox account data queried.`
      : `Live runtime passed: ${result.data.items.length} TorBox downloads returned through an encrypted response. Private names and links withheld.`);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
if (Date.now() >= deadline) throw new Error('Live runtime check timed out. Inspect the existing workflow run before retrying.');
