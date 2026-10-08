import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep, join } from 'node:path';
import { once } from 'node:events';
import { browserSession } from './helpers/browser-session.mjs';
import { sealResult } from '../server/sealed-result.mjs';
import { unzipSync, zipSync, strFromU8 } from '../vendor/fflate.js';

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
        '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.mjs': 'text/javascript', '.wasm': 'application/wasm' })[extname(file)] || 'application/octet-stream' }); response.end(bytes);
    } catch { response.writeHead(404); response.end('Not found'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/unified-book-registry/`;
}
const replies = new Map(); let dispatches = 0;
const fileBytes = Buffer.from('%PDF-1.4\nDownload fixture only.\n');
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const comicBytes = zipSync({ '01.png': imageBytes, '02.png': imageBytes });
const chapterId = '93ea0d72-169d-4418-b48d-95091972a871';
const browser = await browserSession({ intercept: async (request) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-GitHub-Api-Version' };
  if (request.method === 'OPTIONS') return { status: 204, headers };
  const url = new URL(request.url);
  if (url.hostname === 'cdn.example') return { headers: { ...headers, 'Content-Type': url.pathname.endsWith('.cbz') ? 'application/vnd.comicbook+zip' : 'application/pdf' }, body: url.pathname.endsWith('.cbz') ? comicBytes : fileBytes };
  if (url.hostname === 'images.example') return { status: url.pathname.startsWith('/blocked') ? 403 : 200,
    headers: { ...headers, 'Content-Type': url.pathname.startsWith('/blocked') ? 'text/html' : 'image/png' },
    body: url.pathname.startsWith('/blocked') ? '<html>Unavailable fixture image</html>' : imageBytes };
  if (url.hostname === 'getcomics.org') return { headers: { ...headers, 'X-WP-Total': '1', 'Access-Control-Expose-Headers': 'X-WP-Total' }, body: JSON.stringify([
    { id: 123, title: { rendered: 'GetComics fixture (2026)' }, link: 'https://getcomics.org/other-comics/fixture/',
      content: { rendered: '<a href="https://getcomics.org/dls/fixture">DOWNLOAD NOW</a>' } },
  ]) };
  if (url.pathname === '/user') return { headers, body: JSON.stringify({ login: 'jayeshpaluru' }) };
  if (url.pathname.endsWith('/dispatches')) {
    dispatches++;
    const { inputs } = JSON.parse(request.postData);
    const params = JSON.parse(inputs.params);
    let data;
    if (inputs.path === 'torbox/list') data = { items: [params.kind === 'webdl'
      ? { id: 77, kind: 'webdl', ready: true, name: 'Fixture comic', files: [{ id: 0, name: 'Fixture comic.cbz', size: comicBytes.length }] }
      : { id: 1, kind: 'torrents', ready: true, name: 'Private test library', files: [{ id: 0, name: 'Private test book.pdf', size: fileBytes.length }] }] };
    else if (inputs.path === 'torbox/download') data = { url: params.kind === 'webdl' ? 'https://cdn.example/fixture-comic.cbz' : 'https://cdn.example/private-test-book.pdf' };
    else if (inputs.path === 'torbox/add-getcomics') { assert.equal(params.postId, '123'); assert.equal(params.expectedUrl, 'https://getcomics.org/dls/fixture'); data = { id: 77, kind: 'webdl' }; }
    else if (/^(mangapill|weebcentral)\//.test(inputs.path)) {
      const provider = inputs.path.split('/')[0];
      if (inputs.path.endsWith('/search')) data = { items: [{ id: String(params.page || 1), title: `Live fixture page ${params.page || 1}`,
        source: provider, sourceName: provider }], next: Number(params.page || 1) === 1 ? 2 : null };
      else if (inputs.path.endsWith('/chapters')) data = { items: [{ id: provider === 'mangapill' ? '99999-1000' : '01M3DVDYA933SQQ6703XQYMMGQ', chapter: '1', groups: [], source: provider }], total: 1, next: null };
      else if (inputs.path.endsWith('/pages')) data = { pages: ['https://images.example/1.png', 'https://images.example/2.png'] };
      else throw new Error(`Unexpected public reader fixture: ${inputs.path}`);
    }
    else if (inputs.path.endsWith('/chapters')) data = { offset: 0, limit: 100, total: 1, data: [{ id: chapterId,
      attributes: { chapter: '1', pages: 2, translatedLanguage: 'en' },
      relationships: [{ type: 'scanlation_group', id: chapterId, attributes: { name: 'Fixture scans' } }] }] };
    else if (inputs.path.endsWith('/pages')) data = { baseUrl: 'https://images.example', chapter: { hash: 'fixture', data: ['1.png', '2.png'] } };
    else if (inputs.path === 'anna/torrent-info') data = { hash: 'a'.repeat(40), size: 50_000_000, files: 2 };
    else if (inputs.path === 'torbox/add-anna') { assert.equal(JSON.parse(inputs.params).expectedHash, 'a'.repeat(40)); data = { id: 42 }; }
    else throw new Error(`Unexpected mocked operation: ${inputs.path}`);
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
  async function downloaded(name) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try { return await readFile(join(browser.downloadPath, name)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`Browser did not save the fixture file: ${name}`);
  }
  await command('Fetch.enable', { patterns: ['https://api.github.com/*', 'https://cdn.example/*', 'https://images.example/*', 'https://getcomics.org/wp-json/*'].map((urlPattern) => ({ urlPattern })) });
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `
    // Exercise the bounded blob fallback here; direct-to-disk streams are unit-tested.
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
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
  assert.equal(await evaluate(`import('${base}js/reader/book-reader.js').then(reader => {
    const holder=document.createElement('div');holder.append(reader.textToNodes('<math href="javascript:alert(1)"><mi>x</mi></math><a href="#local">safe</a><a href="https://example.com">external</a><template><script>alert(1)</script></template>', 'html'));
    return !holder.querySelector('script,template') && holder.querySelectorAll('[href]').length===1 && holder.querySelector('[href]').getAttribute('href')==='#local';
  })`), true);
  if (server) await evaluate(`import('${base}js/db.js').then(db => db.setSetting('catalogMode', 'static'))`);
  else assert.equal(await evaluate(`import('${base}js/sources/catalog-api.js').then(api => api.catalogMode())`), 'static');
  await evaluate('location.hash = "#/manga"');
  await waitFor('document.querySelectorAll("#view .card").length > 0');
  await evaluate('document.querySelector("[data-source=comikey]").click()');
  await waitFor('document.querySelectorAll("#view .card").length > 0 && document.querySelector(".catalog-tabs .on").textContent === "Comikey"');
  await evaluate('document.querySelector(".card-main").click()');
  await waitFor('document.querySelector(".sheet")?.textContent.includes("public chapter feed is not connected")');
  assert.equal(await evaluate('document.querySelectorAll(".sheet a[href^=http]").length'), 0);
  await evaluate('document.querySelector(".sheet > button").click(); document.querySelector("[data-source=webtoon]").click()');
  await waitFor('document.querySelectorAll("#view .card").length > 0 && document.querySelector(".catalog-tabs .on").textContent === "WEBTOON"');
  await evaluate('location.hash = "#/comics"');
  await waitFor('!!document.querySelector("[data-source=getcomics]")');
  await evaluate('document.querySelector("[data-source=getcomics]").click()');
  await waitFor('document.querySelector("#view .card-title")?.textContent === "GetComics fixture (2026)"');
  assert.equal(await evaluate('!!document.querySelector("[data-source=batcave]")'), false);
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
  await waitFor('!![...document.querySelectorAll(".sheet button")].find(b => b.textContent === "Download to device")');
  assert.equal(await evaluate('document.querySelectorAll(".sheet a[href^=http]").length'), 0);
  assert.equal(dispatches, 2);
  await evaluate('[...document.querySelectorAll(".sheet button")].find(b => b.textContent === "Download file").click()');
  await waitFor('document.querySelector(".sheet")?.textContent.includes("File download started")');
  assert.deepEqual(await downloaded('Private test book.pdf'), fileBytes);
  await evaluate(`document.querySelectorAll('.sheet-backdrop').forEach(el => el.remove());
    Promise.all([import('${base}js/db.js'),import('${base}js/ui/item-menu.js')]).then(async ([db,menu]) => {
      const item={id:'local-download-fixture',title:'Local download fixture',type:'book',format:'text',progress:{}};
      await db.putBlob(item.id,new File(['original local fixture'], 'local-download-fixture.txt', {type:'text/plain'}));
      menu.openItemMenu(item,()=>{});
    })`);
  await waitFor('document.querySelector(".sheet")?.textContent.includes("Local download fixture")');
  await evaluate('[...document.querySelectorAll(".sheet button")].find(b => b.textContent === "Download file").click()');
  await waitFor('document.querySelector(".sheet")?.textContent.includes("Original file download started")');
  assert.equal((await downloaded('local-download-fixture.txt')).toString(), 'original local fixture');
  await evaluate(`document.querySelectorAll('.sheet-backdrop').forEach(el => el.remove());
    import('${base}js/ui/catalog-view.js').then(ui => ui.openCatalogEntry({id:'0a580438-bc72-4503-940b-12a5da881b56',
      title:'Download fixture',source:'mangadex',sourceName:'MangaDex',languages:['en']}))`);
  await waitFor('!![...document.querySelectorAll(".chapter-list button")].find(b => b.textContent === "Download CBZ")');
  await evaluate('[...document.querySelectorAll(".chapter-list button")].find(b => b.textContent === "Download CBZ").click()');
  await waitFor('document.querySelector(".sheet")?.textContent.includes("CBZ download started")');
  const cbz = unzipSync(new Uint8Array(await downloaded('Download fixture Ch. 1.cbz')));
  assert.deepEqual(Object.keys(cbz), ['0001.png', '0002.png', 'ComicInfo.xml']);
  assert.deepEqual(Buffer.from(cbz['0001.png']), imageBytes);
  assert.match(strFromU8(cbz['ComicInfo.xml']), /Fixture scans/);
  await evaluate(`document.querySelectorAll('.sheet-backdrop').forEach(el => el.remove());
    Promise.all([import('${base}js/ui/catalog-view.js'),import('${base}js/sources/anna.js')]).then(([ui,anna]) =>
      ui.openCatalogEntry(anna.mapRecord({_id:'md5:'+ 'b'.repeat(32),_source:{file_unified_data:{
        title_best:'',original_filename_best:'Anna download fixture',extension_best:'pdf',
        classifications_unified:{torrent:['fixture/library.torrent']}}}})))`);
  assert.equal(await evaluate('[...document.querySelectorAll(".sheet button")].some(b => b.textContent === "Download torrent file")'), true);
  assert.equal(await evaluate('document.querySelectorAll(".sheet a[href^=http]").length'), 0);
  assert.match(await evaluate('document.querySelector(".sheet").textContent'), /No catalog title was supplied/);
  await evaluate('[...document.querySelectorAll(".sheet button")].find(b => b.textContent === "Inspect torrent").click()');
  await waitFor('document.querySelector(".sheet")?.textContent.includes("Download with TorBox (0.05 GB)")');
  assert.match(await evaluate('document.querySelector(".sheet").textContent'), /Whole torrent/);
  assert.match(await evaluate('document.querySelector(".sheet").textContent'), /not the exact book file/);
  await evaluate('[...document.querySelectorAll(".sheet button")].find(b => b.textContent === "Download with TorBox (0.05 GB)").click()');
  await waitFor('document.querySelector(".sheet")?.textContent.includes("Submitted to TorBox")');
  assert.equal(dispatches, 6, 'All private operations were intercepted fixtures, not real Actions jobs.');
  for (const provider of ['mangapill', 'weebcentral']) {
    await evaluate(`document.querySelectorAll('.sheet-backdrop').forEach(el => el.remove());
      import('${base}js/ui/catalog-view.js').then(ui => ui.openCatalogEntry({id:'${provider === 'mangapill' ? '99999' : '01J76XY7E9FNDZ1DBBM6PBJZZZ'}', title:'${provider} reader fixture',
        source:'${provider}',sourceName:'${provider}'}))`);
    await waitFor('!![...document.querySelectorAll(".chapter-list button")].find(b => b.textContent === "Download CBZ")');
    await evaluate('[...document.querySelectorAll(".chapter-list button")].find(b => b.textContent === "Download CBZ").click()');
    await waitFor('document.querySelector(".sheet")?.textContent.includes("CBZ download started")');
    const archive = unzipSync(new Uint8Array(await downloaded(`${provider} reader fixture Ch. 1.cbz`)));
    assert.deepEqual(Object.keys(archive), ['0001.png', '0002.png', 'ComicInfo.xml']);
    assert.match(strFromU8(archive['ComicInfo.xml']), new RegExp(provider));
    await evaluate('[...document.querySelectorAll(".chapter-list button")].find(b => b.textContent === "Read here").click()');
    await waitFor('document.querySelector(".ir-stage img")?.naturalWidth > 0');
    assert.equal(await evaluate('document.querySelector(".ir-label").textContent'), '1 / 2');
    assert.equal(await evaluate('document.querySelectorAll(".ir a[href^=http]").length'), 0);
    await evaluate('document.querySelector(".ir-top button").click()');
    await waitFor('!document.body.classList.contains("reading")');
  }
  await evaluate(`location.hash='#/manga'`);
  await waitFor('!!document.querySelector("[data-source=mangapill]")');
  await evaluate('document.querySelector("[data-source=mangapill]").click()');
  await waitFor('document.querySelectorAll("#view .card").length > 0 && document.querySelector(".catalog-tabs .on").textContent === "MangaPill"');
  await evaluate('[...document.querySelectorAll("#view button")].find(b => b.textContent === "Search full provider live").click()');
  await waitFor('document.querySelector("#view")?.textContent.includes("Live fixture page 1")');
  await evaluate('[...document.querySelectorAll("#view button")].find(b => b.textContent === "More live results").click()');
  await waitFor('document.querySelector("#view")?.textContent.includes("Live fixture page 2")');
  await evaluate('document.querySelector("[data-source=weebcentral]").click()');
  await waitFor('document.querySelectorAll("#view .card").length > 0 && document.querySelector(".catalog-tabs .on").textContent === "Weeb Central"');
  await evaluate(`document.querySelectorAll('.sheet-backdrop').forEach(el => el.remove());
    import('${base}js/ui/catalog-view.js').then(ui => ui.openCatalogEntry({id:'123',title:'Comic reader fixture',type:'comic',source:'getcomics',sourceName:'GetComics',
      downloads:[{label:'DOWNLOAD NOW',url:'https://getcomics.org/dls/fixture'}]}))`);
  await waitFor('!![...document.querySelectorAll(".sheet button")].find(b => b.textContent === "Send DOWNLOAD NOW to TorBox")');
  await evaluate('[...document.querySelectorAll(".sheet button")].find(b => b.textContent === "Send DOWNLOAD NOW to TorBox").click()');
  await waitFor('document.querySelector(".sheet")?.textContent.includes("Submitted. Check ready files")');
  await evaluate('[...document.querySelectorAll(".sheet button")].find(b => b.textContent === "Check ready files").click()');
  await waitFor('document.querySelector(".sheet")?.textContent.includes("Fixture comic.cbz · Read / download here")');
  await evaluate('[...document.querySelectorAll(".sheet button")].find(b => b.textContent.includes("Fixture comic.cbz · Read / download here")).click()');
  await evaluate('[...document.querySelectorAll(".sheet button")].findLast(b => b.textContent === "Import and read").click()');
  await waitFor('document.querySelector(".ir-stage img")?.naturalWidth > 0');
  assert.equal(await evaluate('document.querySelector(".ir-label").textContent'), '1 / 2');
  await evaluate('document.querySelector(".ir-top button").click()');
  await waitFor('!document.body.classList.contains("reading")');
  assert.equal(dispatches, 17, 'New provider chapters, paginated searches and comic TorBox operations use fixture jobs only.');
  // Failed image decoding must produce an actionable in-app error, not a blank page.
  await evaluate(`import('${base}js/reader/image-reader.js').then(ui => {
    const host=document.createElement('div');host.id='blocked-reader-test';document.body.append(host);
    window.blockedReader=ui.mountImageReader(host,{item:{title:'Blocked image fixture'},source:{count:1,getUrl:async()=> 'https://images.example/blocked.png',release(){}},onPage(){},onSettings(){},onClose(){}});
  })`);
  await waitFor('document.querySelector("#blocked-reader-test")?.textContent.includes("did not provide a readable page")');
  assert.equal(await evaluate('document.querySelectorAll("#blocked-reader-test a[href^=http]").length'), 0);
  await evaluate('window.blockedReader.destroy();document.querySelector("#blocked-reader-test").remove();location.hash="#/settings"');
  await waitFor(`!!document.querySelector('input[aria-label="GitHub session token"]')`);
  assert.equal(await evaluate('document.querySelectorAll("a[href^=http]").length'), 0);
  assert.equal(await evaluate(`import('${base}js/db.js').then(async db => {
    await db.setSetting('torboxApiKey', 'fixture-key-not-for-backup');
    const exportData = await db.exportMetadata();
    await db.importMetadata({version:1,items:[],settings:{githubToken:'forbidden-restored-token'}});
    return !JSON.stringify(exportData).includes('fake-gh-session-token') && !exportData.settings.torboxApiKey && !(await db.getSetting('githubToken'));
  })`), true);
  await evaluate('navigator.serviceWorker.ready');
  assert.equal(await evaluate(`caches.match('${base}js/sources/github-jobs.js').then(Boolean)`), true);
  assert.equal(await evaluate(`caches.match('${base}icons/registry-maskable-512-v2.png').then(Boolean)`), true);
  assert.equal(await evaluate(`caches.match('${base}js/downloads.js').then(Boolean)`), true);
  assert.equal(await evaluate('document.querySelector(\'link[rel="apple-touch-icon"]\').href'), `${base}icons/registry-apple-touch-v2.png`);
  assert.equal(localApiRequests, 0, 'Static hosted catalogs must not call the localhost companion.');
  assert.equal(await evaluate('document.querySelectorAll(".sheet-backdrop").length'), 0, 'No nested catalog dialog may remain over the reader or Settings.');
  assert.deepEqual(browser.exceptions, []);
  console.log(`Static site smoke passed: ${base} — multiple manga readers, paginated live search, comic TorBox import fixtures, no external-reader links, failed-image errors, file/CBZ saves, metadata imports, credential-safe backups and PWA offline shell.`);
} finally {
  await browser.close();
  if (server) { server.close(); await once(server, 'close'); }
}
