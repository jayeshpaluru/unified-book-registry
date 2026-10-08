import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { once } from 'node:events';
import { browserSession } from './helpers/browser-session.mjs';
import { sealResult } from '../server/sealed-result.mjs';

let server, localApiRequests = 0;
let base = process.env.UBR_SITE_URL;
if (!base) {
  const root = resolve('dist');
  server = createServer(async (request, response) => {
    if (request.url.startsWith('/api/')) localApiRequests++;
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (!pathname.startsWith('/unified-book-registry/')) throw new Error('Outside site prefix');
      const file = resolve(root, pathname.slice('/unified-book-registry/'.length) || 'index.html');
      if (!file.startsWith(root + sep)) throw new Error('Outside artifact');
      const bytes = await readFile(file);
      response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
        '.webmanifest': 'application/manifest+json', '.png': 'image/png' })[extname(file)] || 'application/octet-stream' }); response.end(bytes);
    } catch { response.writeHead(404); response.end('Not found'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/unified-book-registry/`;
}
const replies = new Map(); let dispatches = 0;
const browser = await browserSession({ intercept: async (request) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-GitHub-Api-Version' };
  if (request.method === 'OPTIONS') return { status: 204, headers };
  const url = new URL(request.url);
  if (url.pathname === '/user') return { headers, body: JSON.stringify({ login: 'jayeshpaluru' }) };
  if (url.pathname.endsWith('/dispatches')) {
    dispatches++;
    const { inputs } = JSON.parse(request.postData);
    const data = inputs.path === 'torbox/list' ? { items: [{ id: 1, kind: 'torrents', ready: true, name: 'Private test library',
      files: [{ id: 0, name: 'Private test book.pdf', size: 1024 }] }] } : { url: 'https://cdn.example/private-test-book.pdf' };
    const envelope = sealResult({ requestId: inputs.request_id, expiresAt: Date.now() + 60000, data }, inputs.public_key);
    assert.doesNotMatch(JSON.stringify(envelope), /Private test|cdn\.example/);
    replies.set(inputs.request_id, envelope);
    return { status: 204, headers };
  }
  if (url.pathname.includes('/contents/requests/')) {
    const id = url.pathname.split('/').pop().replace(/\.json$/, '');
    return { headers, body: JSON.stringify({ encoding: 'base64', content: Buffer.from(JSON.stringify(replies.get(id))).toString('base64') }) };
  }
  return { headers, body: JSON.stringify({ id: 1 }) };
} });
try {
  const { command, evaluate, waitFor } = browser;
  await command('Fetch.enable', { patterns: [{ urlPattern: 'https://api.github.com/*' }] });
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `
    const migration = indexedDB.open('ubr', 1);
    migration.onupgradeneeded = () => { for (const [name, keyPath] of Object.entries({items:'id',sources:'id',blobs:null,settings:null}))
      migration.result.createObjectStore(name,keyPath?{keyPath}:undefined); };
    migration.onsuccess = () => { const tx=migration.result.transaction('items','readwrite');
      tx.objectStore('items').put({id:'migration-test',title:'Existing library entry',type:'book',format:'catalog',addedAt:1,
        progress:{pct:42,page:3},catalogEntry:{id:'migration-test',title:'Existing library entry',source:'anna',sourceName:'Anna’s Archive'}});
      tx.oncomplete=()=>migration.result.close(); };
  ` });
  await command('Page.navigate', { url: base });
  await waitFor('!!document.querySelector("#view h1")');
  assert.equal(await evaluate(`import('${base}js/db.js').then(async db => (await db.getItem('migration-test')).progress.pct)`), 42);
  if (server) await evaluate(`import('${base}js/db.js').then(db => db.setSetting('catalogMode', 'static'))`);
  else assert.equal(await evaluate(`import('${base}js/sources/catalog-api.js').then(api => api.catalogMode())`), 'static');
  await evaluate('location.hash = "#/manga"');
  await waitFor('document.querySelectorAll("#view .card").length > 0');
  await evaluate('document.querySelector("[data-source=comikey]").click()');
  await waitFor('document.querySelectorAll("#view .card").length > 0 && document.querySelector(".catalog-tabs .on").textContent === "Comikey"');
  await evaluate('document.querySelector(".card-main").click()');
  await waitFor('document.querySelector(".sheet")?.textContent.includes("paid")');
  await evaluate('document.querySelector(".sheet > button").click(); document.querySelector("[data-source=webtoon]").click()');
  await waitFor('document.querySelectorAll("#view .card").length > 0 && document.querySelector(".catalog-tabs .on").textContent === "WEBTOON"');
  await evaluate('location.hash = "#/comics"');
  await waitFor('!!document.querySelector("[data-source=batcave]")');
  await evaluate('document.querySelector("[data-source=batcave]").click()');
  await waitFor('document.querySelector("#view")?.textContent.includes("backend is not connected")');
  await evaluate('location.hash = "#/settings"');
  await waitFor(`!!document.querySelector('input[aria-label="GitHub session token"]')`);
  await evaluate(`const token = document.querySelector('input[aria-label="GitHub session token"]'); token.value = 'fake-gh-session-token'; token.closest('form').requestSubmit()`);
  await waitFor('document.querySelector("#view")?.textContent.includes("Connected as jayeshpaluru for this tab")');
  assert.equal(await evaluate(`document.querySelector('input[aria-label="GitHub session token"]').value`), '');
  const { root } = await command('DOM.getDocument');
  const { nodeId } = await command('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[accept=".json,.jsonl,.ndjson,.gz,.zst"]' });
  await command('DOM.setFileInputFiles', { nodeId, files: [new URL('./fixtures/anna-metadata.jsonl', import.meta.url).pathname] });
  await waitFor('document.querySelector("#view")?.textContent.includes("3 records imported")');
  await evaluate('location.hash = "#/books"');
  await waitFor('!!document.querySelector("[data-source=torbox]")');
  await evaluate('document.querySelector("[data-source=torbox]").click()');
  await waitFor(`!!document.querySelector('#view select[aria-label="TorBox collection"]')`);
  await evaluate('[...document.querySelectorAll("#view button")].find(b => b.textContent === "Load TorBox library").click()');
  await waitFor('document.querySelector("#view .card-title")?.textContent === "Private test book.pdf"');
  await evaluate('document.querySelector(".card-main").click()');
  await waitFor('!![...document.querySelectorAll(".sheet button")].find(b => b.textContent === "Generate download link")');
  await evaluate('[...document.querySelectorAll(".sheet button")].find(b => b.textContent === "Generate download link").click()');
  await waitFor(`!!document.querySelector('.sheet a[href="https://cdn.example/private-test-book.pdf"]')`);
  assert.equal(dispatches, 2);
  assert.equal(await evaluate(`import('${base}js/db.js').then(async db => {
    await db.setSetting('torboxApiKey', 'fixture-key-not-for-backup');
    const exportData = await db.exportMetadata();
    await db.importMetadata({version:1,items:[],settings:{githubToken:'forbidden-restored-token'}});
    return !JSON.stringify(exportData).includes('fake-gh-session-token') && !exportData.settings.torboxApiKey && !(await db.getSetting('githubToken'));
  })`), true);
  await evaluate('navigator.serviceWorker.ready');
  assert.equal(await evaluate(`caches.match('${base}js/sources/github-jobs.js').then(Boolean)`), true);
  assert.equal(localApiRequests, 0, 'Static hosted catalogs must not call the localhost companion.');
  assert.deepEqual(browser.exceptions, []);
  console.log(`Static site smoke passed: ${base} — nested paths, Comikey, WEBTOON, truthful Batcave status, browser metadata import, encrypted TorBox jobs, fresh download UI, credential-safe backups and offline shell.`);
} finally {
  await browser.close();
  if (server) { server.close(); await once(server, 'close'); }
}
