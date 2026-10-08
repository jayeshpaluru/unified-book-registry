// Optional browser smoke test. Uses an isolated profile, in-memory catalog and
// mocked upstreams; it never changes the user's library or catalog database.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createCatalogServer } from '../server/catalog.mjs';
import { openAnnaStore } from '../server/anna-store.mjs';
import { mapRecord } from '../js/sources/anna.js';

const browserPath = process.env.UBR_BROWSER_PATH || [
  '/Applications/Helium.app/Contents/MacOS/Helium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome',
].find(existsSync);
if (!browserPath) throw new Error('Set UBR_BROWSER_PATH to a Chromium browser executable.');
const fixturePath = new URL('./fixtures/anna-metadata.jsonl', import.meta.url);
const records = readFileSync(fixturePath, 'utf8').trim().split('\n').map(JSON.parse);
const store = openAnnaStore();
records.slice(0, 2).forEach((record) => store.put(mapRecord(record)));
const mangaId = '0a580438-bc72-4503-940b-12a5da881b56';
const chapterId = '93ea0d72-169d-4418-b48d-95091972a871';
const profile = mkdtempSync(join(tmpdir(), 'ubr-browser-smoke-'));
let rateLimitRequests = 0;
const server = createCatalogServer({ store, fetchImpl: async (url, init) => {
  const address = new URL(url);
  if (address.hostname === 'api.mangaupdates.com') assert.notEqual(JSON.parse(init.body).search, '');
  if (address.searchParams.get('title') === 'rate-limit') {
    rateLimitRequests++;
    return new Response('{}', { status: 429 });
  }
  let json;
  if (address.hostname === 'api.mangaupdates.com') json = { total_hits: 1, page: 1, per_page: 25, results: [{ record:
    address.pathname.includes('releases') ? { id: 123, chapter: '1', release_date: '2026-10-07',
      groups: [{ group_id: 42, name: 'Example scans' }] }
      : { series_id: 23606352927, title: 'Example release series', description: 'Test metadata' } }] };
  else if (address.pathname.includes('at-home')) json = { baseUrl: 'https://images.example', chapter: { hash: 'abc', data: ['1.jpg', '2.jpg'] } };
  else if (address.pathname.includes('feed')) json = { offset: 0, limit: 100, total: 1, data: [{ id: chapterId,
    attributes: { chapter: '1', pages: 2, translatedLanguage: 'en' },
    relationships: [{ type: 'scanlation_group', id: mangaId, attributes: { name: 'Example scans' } }] }] };
  else json = { offset: 0, limit: 30, total: 1, data: [{ id: mangaId,
    attributes: { title: { en: 'Example scanlation series' }, originalLanguage: 'ja', availableTranslatedLanguages: ['en'] }, relationships: [] }] };
  return new Response(JSON.stringify(json));
} });
let browser, socket;
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--disable-background-networking',
    '--disable-extensions', '--disable-default-apps', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Browser startup timed out: ${stderr.slice(-1500)}`)), 20000);
    browser.once('error', (error) => { clearTimeout(timer); reject(error); });
    browser.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map(), exceptions = [];
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const commandId = ++id;
      pending.set(commandId, { resolve, reject });
      socket.send(JSON.stringify({ id: commandId, method, params, ...(sessionId && { sessionId }) }));
    });
  }
  socket.addEventListener('message', async (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const promise = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) promise?.reject(new Error(message.error.message)); else promise?.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
    else if (message.method === 'Fetch.requestPaused') {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="white"/><text x="80" y="80">Reader test page</text></svg>';
      await send('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'image/svg+xml' }], body: Buffer.from(svg).toString('base64') }, message.sessionId);
    }
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params) => send(method, params, sessionId);
  await command('Runtime.enable'); await command('Page.enable');
  await command('Fetch.enable', { patterns: [{ urlPattern: 'https://images.example/*' }] });
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  async function waitFor(expression) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`UI wait timed out: ${expression}\n${await evaluate('document.body.innerText')}`);
  }
  await command('Page.navigate', { url: base });
  await waitFor('!!document.querySelector("#view h1")');
  await evaluate(`import('/js/db.js').then(db => db.setSetting('catalogUrl', ${JSON.stringify(base)}))`);
  await evaluate('location.hash = "#/books"');
  await waitFor('document.querySelector("#view .card-title")?.textContent === "Against intellectual monopoly"');
  assert.equal(await evaluate('document.querySelector(".catalog-tabs .on").textContent'), 'Anna’s Archive');
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  const screenshotPath = join(profile, 'books.png');
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  await evaluate('document.querySelector(".card-main").click()');
  await waitFor('!!document.querySelector(".sheet .menu button")');
  await evaluate('document.querySelector(".sheet .menu button").click()');
  await waitFor('document.querySelector(".sheet .menu button")?.textContent === "Saved to library"');
  await evaluate('document.querySelector(".sheet > button").click(); location.hash = "#/comics"');
  await waitFor('document.querySelector("#view .card-title")?.textContent === "Example comic fixture"');
  await evaluate('location.hash = "#/manga"');
  await waitFor('document.querySelector("#view .card-title")?.textContent === "Example scanlation series"');
  await evaluate('document.querySelector(".card-main").click()');
  await waitFor('!!document.querySelector(".chapter-list button")');
  await evaluate('document.querySelector(".chapter-list button").click()');
  await waitFor('document.querySelector(".ir-stage img")?.naturalWidth > 0');
  assert.match(await evaluate('document.querySelector(".reader-credit").textContent'), /MangaDex.*Example scans/);
  assert.equal(await evaluate('document.querySelector(".ir-label").textContent'), '1 / 2');
  await evaluate('document.querySelector(".ir-top button").click()');
  await waitFor('!!document.querySelector("[data-source=mangaupdates]") && !document.body.classList.contains("reading")');
  await evaluate('document.querySelector("[data-source=mangaupdates]").click()');
  await waitFor('document.querySelector("#view .card-title")?.textContent === "Example release series"');
  await evaluate('document.querySelector(".card-main").click()');
  await waitFor('document.querySelector(".chapter-list")?.textContent.includes("Example scans")');
  await evaluate('document.querySelector(".sheet .menu > button").click()');
  await waitFor('document.querySelector(".sheet .menu > button")?.textContent === "Saved to library"');
  await evaluate('document.querySelector(".sheet > button").click(); location.hash = "#/settings"');
  await waitFor('document.querySelector("#view")?.textContent.includes("Connected · 2 Anna’s Archive records")');
  await evaluate('location.hash = "#/manga"');
  await waitFor('document.querySelector("#view .card-title")?.textContent === "Example release series"');
  assert.equal(await evaluate('document.querySelector(".catalog-tabs .on").textContent'), 'MangaUpdates');
  await evaluate('document.querySelector("[data-source=mangadex]").click()');
  await waitFor('document.querySelector("#view .card-title")?.textContent === "Example scanlation series"');
  await evaluate('const search = document.querySelector("#view input[type=search]"); search.value = "rate-limit"; search.dispatchEvent(new Event("input"));');
  await waitFor('document.querySelector("#view .status")?.textContent.includes("rate limiting")');
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(rateLimitRequests, 1, 'Failed infinite-scroll requests must not automatically repeat.');
  await evaluate('document.querySelector("#view .status button").click()');
  await waitFor('document.querySelector("#view .status")?.textContent.includes("rate limiting")');
  assert.equal(rateLimitRequests, 2, 'An explicit Retry makes one more request.');
  await evaluate('location.hash = "#/settings"');
  await waitFor('document.querySelector("#view")?.textContent.includes("Connected · 2 Anna’s Archive records")');
  const { root } = await command('DOM.getDocument');
  const { nodeId } = await command('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[accept=".json,.jsonl,.ndjson,.gz,.zst"]' });
  await command('DOM.setFileInputFiles', { nodeId, files: [fixturePath.pathname] });
  await waitFor('document.querySelector("#view")?.textContent.includes("Connected · 3 Anna’s Archive records")');
  assert.equal(await evaluate('import("/js/db.js").then(async db => { const data = await db.exportMetadata(); await db.clearAll(); return (await db.importMetadata(data)).restored; })'), 3);
  await evaluate('location.hash = "#/library"');
  await waitFor('document.querySelectorAll("#view .grid .card").length === 3');
  await evaluate('navigator.serviceWorker.ready');
  assert.equal(await evaluate('caches.match("/js/sources/anna.js").then(Boolean)'), true);
  assert.deepEqual(exceptions, []);
  console.log('Browser smoke passed: Books, Comics, MangaDex chapter reader, MangaUpdates releases, remembered catalogs, rate-limit retry, metadata upload, backup restore and offline shell.');
  if (process.env.UBR_SMOKE_SCREENSHOT) {
    writeFileSync(process.env.UBR_SMOKE_SCREENSHOT, readFileSync(screenshotPath));
    console.log(`Screenshot: ${process.env.UBR_SMOKE_SCREENSHOT}`);
  }
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); await once(browser, 'exit'); }
  server.close(); await once(server, 'close'); store.close();
  rmSync(profile, { recursive: true, force: true });
}
