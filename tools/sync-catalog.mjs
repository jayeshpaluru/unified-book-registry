import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCatalogApi } from '../server/catalog.mjs';
import { openAnnaStore } from '../server/anna-store.mjs';
import { parseComikey, parseWebtoon } from '../server/public-catalogs.mjs';
import { mapManga } from '../js/sources/mangadex.js';
import { mapSeries } from '../js/sources/mangaupdates.js';

const pause = () => new Promise((resolve) => setTimeout(resolve, 550));
const jsonFile = async (path, value) => { await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value)); };

export async function syncCatalog({ output = resolve('build/catalog'), fetchImpl = fetch, pages = 5, details = true,
  annaDb = process.env.UBR_ANNA_DB || ':memory:' } = {}) {
  await mkdir(output, { recursive: true });
  let previous, previousSource = 'local';
  const repository = process.env.GITHUB_REPOSITORY || 'jayeshpaluru/unified-book-registry';
  const [owner, name] = repository.split('/');
  const published = `https://${owner}.github.io/${name}/catalog/`;
  try { previous = JSON.parse(await readFile(resolve('catalog/manifest.json'), 'utf8')); } catch {}
  if (process.env.GITHUB_ACTIONS) {
    try {
      const response = await fetchImpl(`${published}manifest.json`, { signal: AbortSignal.timeout(15000) });
      if (response.ok) { const data = await response.json(); if (data.version === 1) { previous = data; previousSource = 'published'; } }
    } catch {}
  }
  const manifest = { version: 1, updatedAt: new Date().toISOString(), providers: {}, details: {},
    runtime: { repo: process.env.GITHUB_REPOSITORY || 'jayeshpaluru/unified-book-registry', workflow: 'runtime.yml', branch: 'runtime-results' } };
  // Never open the ongoing full local import as a side effect of building Pages.
  // Large indexes belong in separately connected storage, not a JSON snapshot.
  const store = openAnnaStore(annaDb);
  const api = createCatalogApi(store, { fetchImpl });
  async function previousFile(path) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').includes('..')) throw new Error('Invalid previous catalog path.');
    if (previousSource === 'local') return JSON.parse(await readFile(resolve('catalog', path), 'utf8'));
    const response = await fetchImpl(`${published}${path}`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Previous catalog could not be restored.');
    return response.json();
  }
  async function restore(name) {
    const provider = previous?.providers?.[name];
    if (!provider?.records) return null;
    return (await Promise.all(provider.files.map(previousFile))).flat();
  }
  async function collect(name, run, coverage) {
    try {
      let records = await run(), restored = false;
      if (name === 'anna' && !records.length && previous?.providers?.anna?.records) { records = await restore(name); restored = true; }
      const files = [];
      for (let i = 0; i < records.length; i += 500) {
        const path = `records/${name}/${String(i / 500).padStart(5, '0')}.json`;
        await jsonFile(join(output, path), records.slice(i, i + 500)); files.push(path);
      }
      manifest.providers[name] = { status: records.length ? 'ready' : 'empty', records: records.length, files,
        coverage: restored ? previous.providers[name].coverage : coverage,
        updatedAt: restored ? previous.providers[name].updatedAt : manifest.updatedAt };
      console.log(`${name}: ${records.length} public catalog entries.`);
      return records;
    } catch (error) {
      const restored = await restore(name).catch(() => null);
      if (restored) {
        const provider = previous.providers[name];
        for (let i = 0; i < provider.files.length; i++) await jsonFile(join(output, provider.files[i]), await previousFile(provider.files[i]));
        manifest.providers[name] = { ...provider, status: 'stale', error: error.message };
        console.log(`${name}: retained ${restored.length} entries from the last successful snapshot (${error.message}).`);
        return restored;
      }
      manifest.providers[name] = { status: 'unavailable', records: 0, files: [], coverage, error: error.message };
      console.log(`${name}: ${error.message}`);
      return [];
    }
  }
  const md = await collect('mangadex', async () => {
    const entries = [];
    for (let page = 0; page < pages; page++) {
      const json = await api('mangadex/search', new URLSearchParams({ offset: page * 30 }));
      entries.push(...json.data.map((raw) => ({ entry: mapManga(raw), raw })));
      if (json.offset + json.limit >= json.total) break;
      await pause();
    }
    return entries;
  }, 'Popular safe/suggestive titles; use live search for the full provider catalog.');
  const mu = await collect('mangaupdates', async () => {
    const entries = [];
    for (let page = 1; page <= pages; page++) {
      const json = await api('mangaupdates/search', new URLSearchParams({ page }));
      entries.push(...json.results.map(({ record: raw }) => ({ entry: mapSeries(raw), raw })));
      if (json.page * json.per_page >= json.total_hits) break;
      await pause();
    }
    return entries;
  }, 'Series with scanlation releases; use live search for the full provider catalog.');
  const readerEntries = {};
  for (const name of ['mangapill', 'weebcentral', 'getcomics']) {
    readerEntries[name] = await collect(name, async () => {
      const entries = new Map(); let cursor = name === 'getcomics' ? 0 : 1;
      for (let page = 0; page < pages; page++) {
        const result = await api(`${name}/search`, new URLSearchParams(name === 'getcomics' ? { offset: cursor } : { page: cursor }));
        result.items.forEach((entry) => entries.set(entry.id, entry));
        cursor = result.next;
        if (cursor === null) break;
        await pause();
      }
      return [...entries.values()];
    }, name === 'getcomics' ? 'Recent public archive listings; direct live search covers the provider feed. Files are retrieved through TorBox.'
      : 'Public manga directory snapshot; live Actions search covers the provider directory. English chapters read here.');
  }
  async function html(url) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error(`Public catalog returned HTTP ${response.status}.`);
    return response.text();
  }
  await collect('comikey', async () => {
    const entries = new Map();
    for (let page = 1; page <= 50; page++) {
      const result = parseComikey(await html(`https://comikey.com/comics/?page=${page}`));
      const before = entries.size;
      result.items.forEach((entry) => entries.set(entry.id, entry));
      if (!result.next || before === entries.size) break;
      await pause();
    }
    return [...entries.values()];
  }, 'Official publisher directory; free and paid chapter access varies by title.');
  await collect('webtoon', async () => {
    const { items } = parseWebtoon(await html('https://www.webtoons.com/en/originals'));
    if (!items.length) throw new Error('WEBTOON catalog markup changed.');
    return items;
  }, 'Current-day English Originals directory, not every WEBTOON series.');
  await collect('anna', async () => {
    if (store.total() > 10000) throw new Error('The full Anna index must not be published as Pages JSON. Connect a finalized storage index instead.');
    const entries = [];
    for (let offset = 0; offset < store.total(); offset += 500) entries.push(...store.search('', { offset, limit: 500 }).items);
    return entries;
  }, 'Imported combined aarecord metadata only; no full mirror is bundled.');
  if (details) {
    for (const [key, path] of Object.entries(previous?.details || {})) {
      try { await jsonFile(join(output, path), await previousFile(path)); manifest.details[key] = path; } catch {}
    }
    for (const [provider, entries] of [['mangadex', md], ['mangaupdates', mu]]) {
      for (const { entry } of entries.slice(0, 30)) {
        const path = provider === 'mangadex' ? `mangadex/manga/${entry.id}/chapters` : `mangaupdates/series/${entry.id}/releases`;
        const params = new URLSearchParams(provider === 'mangadex' ? { language: 'en', offset: 0 } : { page: 1 });
        try {
          const value = await api(path, params);
          const file = `details/${provider}/${entry.id}.json`;
          await jsonFile(join(output, file), value);
          manifest.details[`${path}?${params}`] = file;
        } catch (error) { console.log(`${provider} release metadata unavailable: ${error.message}`); }
        await pause();
      }
    }
    for (const provider of ['mangapill', 'weebcentral']) {
      for (const entry of readerEntries[provider].slice(0, 10)) {
        const path = `${provider}/series/${entry.id}/chapters`, params = new URLSearchParams({ offset: 0 });
        try {
          const value = await api(path, params), file = `details/${provider}/${entry.id}.json`;
          await jsonFile(join(output, file), value); manifest.details[`${path}?${params}`] = file;
        } catch (error) { console.log(`${provider} chapter metadata unavailable: ${error.message}`); }
        await pause();
      }
    }
  }
  store.close();
  if (Object.entries(manifest.providers).filter(([name, data]) => name !== 'anna' && data.records > 0).length < 2) {
    throw new Error('Deployment requires at least two working non-Gutenberg catalog sources.');
  }
  await jsonFile(join(output, 'manifest.json'), manifest);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  syncCatalog().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
