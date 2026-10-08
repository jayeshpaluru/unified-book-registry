// A real browser/WASM/HTTP range test with only synthetic metadata and mocked
// GitHub jobs. No TorBox account, source dump or user's database is touched.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { openAnnaStore } from '../server/anna-store.mjs';
import { exportAnnaIndex } from '../server/anna-index.mjs';
import { mapRecord } from '../js/sources/anna.js';
import { sealResult } from '../server/sealed-result.mjs';
import { browserSession } from './helpers/browser-session.mjs';

const directory = await mkdtemp(join(tmpdir(), 'ubr-range-browser-'));
const sourcePath = join(directory, 'source.sqlite');
const plan = { snapshot: '20260208', hash: 'a'.repeat(40), files: Array.from({ length: 12 }, (_, shard) => ({ index: shard + 1, shard })) };
let source, app, files, browser, servedBytes = 0, rangeRequests = 0;
try {
  source = openAnnaStore(sourcePath); source.begin();
  source.put(mapRecord({ id: 'fixture-book', title: 'Range search fixture', author: 'Example Author', isbn: ['9781234567890'] }));
  source.put(mapRecord({ id: 'fixture-comic', file_unified_data: { title_best: 'Range comic fixture', author_best: 'Example Author', content_type_best: 'comic' } }));
  for (let i = 0; i < 4000; i++) source.put({ ...mapRecord({ id: `filler-${i}`, title: `Filler catalog entry ${i}`, author: 'Filler Author' }), summary: 'Fixture metadata. '.repeat(100) });
  source.commit(); plan.files.forEach((file) => source.finishImport(`${plan.hash}:${file.index}`, 1));
  const exported = await exportAnnaIndex({ sourcePath, plan, directory: join(directory, 'export'), reserveBytes: 0n });
  source.close(); source = null;
  const bytes = await readFile(exported.file);
  files = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Range, Cache-Control, Pragma');
    response.setHeader('Access-Control-Allow-Private-Network', 'true'); // Only this disposable fixture's loopback server.
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    if (pathname !== '/hidden-header') response.setHeader('Access-Control-Expose-Headers', 'Content-Range, ETag');
    response.setHeader('ETag', '"immutable-fixture"');
    if (pathname === '/full-file') { response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); response.end(bytes); return; }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
    if (!range) { response.writeHead(400); response.end(); return; }
    const first = Number(range[1]), last = Math.min(Number(range[2]), bytes.length - 1);
    if (first > last) { response.writeHead(416); response.end(); return; }
    const chunk = bytes.subarray(first, last + 1);
    response.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${first}-${last}/${bytes.length}`, 'Content-Length': chunk.length });
    servedBytes += chunk.length; rangeRequests++; response.end(chunk);
  });
  files.listen(0, '127.0.0.1'); await once(files, 'listening');
  const fileBase = `http://127.0.0.1:${files.address().port}`;
  const fileUrl = `${fileBase}/metadata.sqlite?temporary-link=fixture-only`;
  const artifactRoot = resolve('dist');
  const remoteBase = process.env.UBR_SITE_URL;
  let base = remoteBase;
  if (!base) {
    app = createServer(async (request, response) => {
      try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        if (!pathname.startsWith('/unified-book-registry/')) throw new Error('Outside site');
        const path = resolve(artifactRoot, pathname.slice('/unified-book-registry/'.length) || 'index.html');
        if (!path.startsWith(artifactRoot + sep)) throw new Error('Outside artifact');
        const bytes = await readFile(path);
        response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
          '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' })[extname(path)] || 'application/octet-stream' });
        response.end(bytes);
      } catch { response.writeHead(404); response.end(); }
    });
    app.listen(0, '127.0.0.1'); await once(app, 'listening'); base = `http://127.0.0.1:${app.address().port}/unified-book-registry/`;
  }
  const replies = new Map(); let dispatches = 0;
  browser = await browserSession({ intercept: async (request) => {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-GitHub-Api-Version' };
    if (request.method === 'OPTIONS') return { status: 204, headers };
    const url = new URL(request.url);
    if (url.pathname === '/user') return { headers, body: JSON.stringify({ login: 'jayeshpaluru' }) };
    if (url.pathname.endsWith('/dispatches')) {
      const { inputs } = JSON.parse(request.postData); dispatches++;
      let data;
      if (inputs.path === 'torbox/list') data = { items: [{ id: 7, kind: 'torrents', ready: true, files: [{ id: 0, name: 'Private fixture index/anna-index.sqlite', size: bytes.length }] }] };
      else if (inputs.path === 'torbox/download') data = { url: fileUrl };
      else throw new Error('Unexpected mocked private operation.');
      const envelope = sealResult({ requestId: inputs.request_id, expiresAt: Date.now() + 60000, data }, inputs.public_key);
      assert.doesNotMatch(JSON.stringify(envelope), /Private fixture|temporary-link/); replies.set(inputs.request_id, envelope);
      return { status: 204, headers };
    }
    if (url.pathname.includes('/contents/requests/')) {
      const id = url.pathname.split('/').pop().replace(/\.json$/, '');
      return { headers, body: JSON.stringify({ content: Buffer.from(JSON.stringify(replies.get(id))).toString('base64') }) };
    }
    return { headers, body: JSON.stringify({ id: 1 }) };
  } });
  const { command, evaluate, waitFor } = browser;
  if (remoteBase) {
    // Chrome's public-site -> loopback restriction applies to this fixture,
    // not to TorBox's public CDN. Grant only in this disposable test profile.
    const { product } = await command('Browser.getVersion');
    const major = Number(/Chrome\/(\d+)/.exec(product)?.[1] || 0);
    if (major >= 138) await command('Browser.setPermission', { permission: { name: major >= 146 ? 'loopback-network' : 'local-network-access' },
      setting: 'granted', origin: new URL(base).origin });
  }
  await command('Fetch.enable', { patterns: [{ urlPattern: 'https://api.github.com/*' }] });
  await command('Page.navigate', { url: base }); await waitFor('!!document.querySelector("#view h1")');
  if (remoteBase && process.env.UBR_INDEX_DEBUG) {
    console.log('Fixture permission states:', await evaluate(`Promise.all(['local-network-access','loopback-network','local-network'].map(async name=>{try{return {name,state:(await navigator.permissions.query({name})).state};}catch(error){return {name,error:error.message};}}))`));
    console.log('Page fixture probe:', await evaluate(`fetch(${JSON.stringify(fileUrl)},{headers:{Range:'bytes=0-99'}}).then(async response=>({status:response.status,range:response.headers.get('content-range'),length:(await response.arrayBuffer()).byteLength})).catch(error=>({name:error.name,error:error.message}))`));
  }
  await evaluate(`import('${base}js/db.js').then(db => db.setSetting('catalogMode','static'))`);
  await evaluate('location.hash = "#/settings"');
  await waitFor('!!document.querySelector(\'input[aria-label="GitHub session token"]\')');
  await evaluate('const token=document.querySelector(\'input[aria-label="GitHub session token"]\');token.value="fake-index-session";token.closest("form").requestSubmit()');
  await waitFor('document.body.textContent.includes("Connected as jayeshpaluru")');
  await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="Load Anna index files from TorBox").click()');
  await waitFor('!![...document.querySelectorAll("button")].find(b=>b.textContent.startsWith("anna-index.sqlite ·"))');
  await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.startsWith("anna-index.sqlite ·")).click()');
  await waitFor('document.body.textContent.includes("complete selected snapshot")');
  assert.equal(dispatches, 2);
  const query = (text, type, offset = 0) => evaluate(`import('${base}js/sources/anna.js').then(anna=>anna.search(${JSON.stringify(text)},${offset},${JSON.stringify(type)}))`);
  assert.deepEqual((await query('Range search', 'book')).items.map(item => item.id), ['fixture-book']);
  assert.equal((await query('Example Author')).total, 2);
  assert.deepEqual((await query('978-1-234-56789-0', 'book')).items.map(item => item.id), ['fixture-book']);
  assert.deepEqual((await query('Range', 'comic')).items.map(item => item.id), ['fixture-comic']);
  assert.equal((await query('', 'comic')).total, 1);
  assert.equal((await query('missing-query')).total, 0);
  assert.equal((await query('?!')).total, 0);
  assert.ok(servedBytes < bytes.length / 2, `${servedBytes} fetched out of ${bytes.length}; the full database must not be downloaded.`);
  assert.ok(rangeRequests > 0);
  const beforeBroadQuery = servedBytes;
  const broad = await query('Filler Author', 'book');
  assert.equal(broad.total, 4000); assert.equal(broad.items.length, 30); assert.equal(broad.next, 30);
  assert.ok(servedBytes - beforeBroadQuery < bytes.length / 4, 'A broad author query must count matches from the search index, not scan every full metadata record.');
  assert.equal((await query('Filler Author')).total, 4000);
  const latePage = await query('Filler Author', 'book', 3990);
  assert.equal(latePage.total, 4000); assert.equal(latePage.next, null);
  assert.deepEqual(latePage.items.map(item => item.id), Array.from({ length: 10 }, (_, n) => `filler-${3990 + n}`));
  assert.equal(await evaluate(`import('${base}js/db.js').then(async db=>!JSON.stringify(await db.exportMetadata()).includes('temporary-link'))`), true);
  await evaluate('navigator.serviceWorker.ready');
  assert.equal(await evaluate(`caches.keys().then(async names=>(await Promise.all(names.map(async name=>(await(await caches.open(name)).keys()).some(request=>request.url.includes('temporary-link'))))).some(Boolean))`), false);
  assert.equal(await evaluate('crossOriginIsolated'), false, 'The browser reader must not depend on Pages COOP/COEP headers or SharedArrayBuffer.');
  await evaluate('location.hash = "#/comics"');
  await waitFor('document.querySelector("#view .card-title")?.textContent==="Range comic fixture"');
  assert.match(await evaluate('document.querySelector("#view").textContent'), /Connected TorBox index/);
  await evaluate('location.hash = "#/settings"');
  await waitFor('!![...document.querySelectorAll("button")].find(b=>b.textContent==="Disconnect Anna index")');
  await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="Disconnect Anna index").click()');
  assert.equal(await evaluate(`import('${base}js/sources/anna-index.js').then(index=>index.connectedIndex())`), null);
  const beforeDisconnectQuery = rangeRequests;
  await query('', 'comic');
  assert.equal(rangeRequests, beforeDisconnectQuery, 'Disconnecting returns Anna searches to the Pages/local-browser catalog.');
  for (const endpoint of ['hidden-header', 'full-file']) {
    const message = await evaluate(`import('${base}js/sources/anna-index.js').then(async index=>{try{await index.connectIndex(${JSON.stringify(fileBase + '/' + endpoint)});return 'unexpected-success';}catch(error){return error.message;}})`);
    assert.match(message, endpoint === 'hidden-header' ? /Content-Range/ : /206/);
    assert.doesNotMatch(message, /temporary-link|127\.0\.0\.1/);
  }
  assert.deepEqual(browser.exceptions, []);
  console.log(`Browser index smoke passed: real SQLite FTS5 over cross-origin 206 ranges, title/author/ISBN/comic search, fixture TorBox selection, bounded transfer (${servedBytes} of ${bytes.length} bytes), no SharedArrayBuffer, credential-safe backups and explicit CORS/full-download rejection.`);
} finally {
  await browser?.close(); source?.close();
  for (const server of [app, files].filter(Boolean)) { server.close(); await once(server, 'close'); }
  await rm(directory, { recursive: true, force: true });
}
