import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncCatalog } from '../tools/sync-catalog.mjs';
import { openAnnaStore } from '../server/anna-store.mjs';
import { DatabaseSync } from 'node:sqlite';

const fetchImpl = async (value) => {
  const url = new URL(value);
  if (url.hostname === 'api.mangadex.org') return Response.json({ data: [{ id: '0a580438-bc72-4503-940b-12a5da881b56', attributes: { title: { en: 'Fixture manga' } }, relationships: [] }], offset: 0, limit: 30, total: 1 });
  if (url.hostname === 'api.mangaupdates.com') return Response.json({ results: [{ record: { series_id: 123, title: 'Fixture releases' } }], page: 1, per_page: 25, total_hits: 1 });
  if (url.hostname === 'mangapill.com') return new Response('<a href="/manga/2/fixture">Fixture manga</a>');
  if (url.hostname === 'mangakatana.com') return new Response('<div id="book_list"><a href="/manga/fixture.49">Fixture manga</a></div>');
  if (url.hostname === 'weebcentral.com') return new Response('<a href="/series/01J76XY7E9FNDZ1DBBM6PBJPFK/fixture"><img src="https://images.example/cover.jpg" alt="Fixture manga cover"></a>');
  if (url.hostname === 'getcomics.org') return Response.json([{ id: 123, title: { rendered: 'Fixture comic' }, link: 'https://getcomics.org/other-comics/fixture/', content: { rendered: '<a href="https://getcomics.org/dls/fixture">DOWNLOAD NOW</a>' } }], { headers: { 'X-WP-Total': '1' } });
  if (url.hostname === 'comikey.com') return new Response('<li class="item-full-row item-preview"><span class="title"><a href="https://comikey.com/comics/fixture/10/">Fixture comic</a></span></li>');
  if (url.hostname === 'www.webtoons.com') return new Response('<a class="link _originals_title_a" data-title-no="12" href="https://www.webtoons.com/en/fantasy/fixture/list?title_no=12"><strong class="title">Fixture webtoon</strong></a>');
  throw new Error(`Unexpected public metadata request: ${url.hostname}`);
};
test('Static snapshots include multiple native manga catalogs and GetComics without touching the full local Anna importer', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ubr-catalog-build-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = await syncCatalog({ output: dir, fetchImpl, pages: 1, details: false, annaDb: ':memory:' });
  for (const provider of ['mangapill', 'weebcentral', 'mangakatana', 'getcomics']) {
    assert.equal(result.providers[provider].status, 'ready'); assert.equal(result.providers[provider].records, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, result.providers[provider].files[0])))[0].source, provider);
  }
  assert.equal(result.providers.anna.records, 0); assert.equal(result.providers.batcave, undefined);
});
test('A large Anna store is never materialized into a Pages JSON catalog', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ubr-catalog-budget-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'large-fixture.sqlite'), store = openAnnaStore(path); store.close();
  // Count-only fixture exercises the guard without creating millions of records.
  const db = new DatabaseSync(path); db.prepare('UPDATE catalog_counts SET total = ?').run(10001); db.close();
  const result = await syncCatalog({ output: join(dir, 'public'), fetchImpl, pages: 1, details: false, annaDb: path });
  assert.equal(result.providers.anna.status, 'unavailable'); assert.equal(result.providers.anna.records, 0);
  assert.deepEqual(result.providers.anna.files, []); assert.match(result.providers.anna.error, /must not be published/);
});
test('An older deployed manifest cannot erase newly checked-in providers when GitHub runners are blocked', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ubr-catalog-fallback-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const oldEnvironment = process.env.GITHUB_ACTIONS; process.env.GITHUB_ACTIONS = 'true';
  t.after(() => { if (oldEnvironment === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = oldEnvironment; });
  const local = JSON.parse(readFileSync('catalog/manifest.json', 'utf8'));
  const result = await syncCatalog({ output: dir, pages: 1, details: false, annaDb: ':memory:', fetchImpl: async (value) => {
    const url = new URL(value);
    if (url.hostname === 'jayeshpaluru.github.io') return Response.json({ version: 1, providers: {}, details: {}, updatedAt: '2000-01-01T00:00:00.000Z' });
    if (['weebcentral.com', 'getcomics.org'].includes(url.hostname)) return new Response('', { status: 403 });
    return fetchImpl(value);
  } });
  for (const provider of ['weebcentral', 'getcomics']) {
    assert.equal(result.providers[provider].status, 'stale'); assert.equal(result.providers[provider].records, local.providers[provider].records);
    assert.match(result.providers[provider].error, /403/);
    assert.equal(JSON.parse(readFileSync(join(dir, result.providers[provider].files[0]))).length, local.providers[provider].records);
  }
});
