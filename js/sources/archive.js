// Internet Archive public-domain Golden Age comic collections.
import { fetchJson } from '../util.js';

// Fawcett and Ace comics whose copyrights were not renewed (the same material
// the Digital Comic Museum hosts). Status is as asserted by the uploaders.
export const COLLECTIONS = [
  'fawcett-comics',
  'fawcett-americas-greatest-comics',
  'fawcett-beware-terror-tales',
  'captainmarveladventures',
  'ace-comics',
  'super-mystery-comics',
  'four-favorites-comics',
  'webofmystery-comics',
];

const ADVANCED_SEARCH = 'https://archive.org/advancedsearch.php';
export const PAGE_SIZE = 30;

export const coverUrl = (id) => `https://archive.org/services/img/${encodeURIComponent(id)}`;

export function buildQuery(text) {
  const words = text.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean);
  const base = `collection:(${COLLECTIONS.join(' OR ')}) AND mediatype:texts`;
  return words.length ? `${base} AND title:(${words.join(' AND ')})` : base;
}

export function searchUrl(text, page = 1) {
  const p = new URLSearchParams({ q: buildQuery(text), rows: PAGE_SIZE, page, output: 'json' });
  for (const f of ['identifier', 'title', 'year', 'creator']) p.append('fl[]', f);
  if (!text.trim()) p.append('sort[]', 'downloads desc');
  return `${ADVANCED_SEARCH}?${p}`;
}

export function mapSearch(json) {
  const { numFound, start, docs } = json.response;
  return {
    total: numFound,
    hasMore: start + docs.length < numFound,
    items: docs.map((d) => ({
      id: d.identifier,
      title: d.title || d.identifier,
      year: d.year || null,
      cover: coverUrl(d.identifier),
    })),
  };
}

export async function search(text, page) {
  return mapSearch(await fetchJson(searchUrl(text, page)));
}

export const manifestUrl = (id) => `https://iiif.archive.org/iiif/3/${encodeURIComponent(id)}/manifest.json`;

// Per-page image URLs from an IIIF Presentation 3 manifest.
export function mapManifest(manifest) {
  const pages = manifest.items
    .map((canvas) => canvas.items?.[0]?.items?.[0]?.body?.id)
    .filter(Boolean);
  return { pages, rtl: manifest.viewingDirection === 'right-to-left' };
}

export async function loadPages(id) {
  const result = mapManifest(await fetchJson(manifestUrl(id)));
  if (!result.pages.length) throw new Error('This item has no readable pages.');
  return result;
}

export function mapDownloads(id, metadata) {
  if (metadata.is_dark || String(metadata.metadata?.['access-restricted-item']).toLowerCase() === 'true') return [];
  return (metadata.files || []).filter((file) => ![true, 'true', 1, '1'].includes(file.private)
    && /\.(pdf|epub|cbz)$/i.test(file.name || '') && !file.name.split('/').some((part) => !part || part === '..' || part === '.'))
    .map((file) => ({ name: file.name, size: Number(file.size) || 0, format: file.name.split('.').pop().toUpperCase(),
      url: `https://archive.org/download/${encodeURIComponent(id)}/${file.name.split('/').map(encodeURIComponent).join('/')}` }));
}
export async function loadDownloads(id) {
  return mapDownloads(id, await fetchJson(`https://archive.org/metadata/${encodeURIComponent(id)}`));
}
