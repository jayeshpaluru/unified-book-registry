import * as db from '../db.js';
import { searchRecords } from './catalog-search.js';
import { githubJob, hasGithubSession } from './github-jobs.js';

const root = new URL('../../catalog/', import.meta.url);
const files = new Map();
let manifest, checkedAt = 0;
async function load(path) {
  if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').includes('..')) throw new Error('Invalid static catalog path.');
  const response = await fetch(new URL(path, root), { cache: 'no-cache' });
  if (!response.ok) throw new Error('Static catalog is unavailable. Check the latest deployment in GitHub Actions.');
  return response.json();
}
export async function catalogManifest() {
  if (!manifest || Date.now() - checkedAt > 300000) {
    const next = await load('manifest.json');
    if (manifest?.updatedAt !== next.updatedAt) files.clear();
    if (next.version !== 1) throw new Error('Unsupported static catalog version.');
    manifest = next; checkedAt = Date.now();
  }
  return manifest;
}
async function records(provider) {
  const meta = (await catalogManifest()).providers[provider];
  if (!meta) throw new Error('This source is not in the static catalog.');
  if (meta.status === 'unavailable' || meta.status === 'external') throw new Error(meta.error || 'This provider is unavailable.');
  if (!files.has(provider)) files.set(provider, Promise.all(meta.files.map(load)).then((pages) => pages.flat()).catch((error) => { files.delete(provider); throw error; }));
  return files.get(provider);
}

export async function staticRequest(path, params = {}, init = {}) {
  const index = await catalogManifest();
  if (path === 'health') {
    const personal = await db.all('annaRecords');
    return { annaRecords: (index.providers.anna?.records || 0) + personal.length, importing: false,
      static: true, updatedAt: index.updatedAt, providers: index.providers, runtimeConnected: hasGithubSession() };
  }
  if (init.live) return githubJob(path, params, init);
  const provider = /^([a-z]+)\/search$/.exec(path)?.[1];
  if (provider) {
    let data = await records(provider);
    if (provider === 'anna') {
      const personal = await db.all('annaRecords');
      const combined = new Map(data.map((record) => [record.id, record]));
      personal.forEach((record) => combined.set(record.id, record)); data = [...combined.values()];
    }
    const scanlation = ['mangapill', 'weebcentral'].includes(provider);
    const offset = provider === 'mangaupdates' ? (Number(params.page || 1) - 1) * 25 : scanlation ? (Number(params.page || 1) - 1) * 30 : Number(params.offset || 0);
    const limit = provider === 'mangaupdates' ? 25 : 30;
    const result = searchRecords(data, params.q, { offset, limit, type: params.type });
    if (provider === 'mangadex') return { data: result.items.map((record) => record.raw), total: result.total, offset, limit };
    if (provider === 'mangaupdates') return { results: result.items.map((record) => ({ record: record.raw })),
      total_hits: result.total, page: Number(params.page || 1), per_page: limit };
    return scanlation ? { ...result, next: result.next === null ? null : Math.floor(result.next / 30) + 1 } : result;
  }
  const defaults = path.startsWith('mangadex/') ? { language: params.language || 'en', offset: params.offset || 0 }
    : /^(?:mangapill|weebcentral)\/series\//.test(path) ? { offset: params.offset || 0 } : { page: params.page || 1 };
  const key = `${path}?${new URLSearchParams(defaults)}`;
  const cached = index.details[key];
  if (cached) return load(cached);
  return githubJob(path, params, init);
}
