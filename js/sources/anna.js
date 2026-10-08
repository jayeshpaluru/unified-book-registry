import { catalogRequest, catalogMode } from './catalog-api.js';
import { ANNA_SOURCE_ORIGIN, torrentReferences } from './anna-downloads.js';
import { connectedIndex, searchIndex } from './anna-index.js';
export const ANNA_ORIGIN = ANNA_SOURCE_ORIGIN;
const strings = (value) => (Array.isArray(value) ? value : value == null ? [] : [value])
  .filter((v) => typeof v === 'string' || typeof v === 'number').map(String).filter(Boolean);
const text = (value) => typeof value === 'string' ? value.trim() : '';

// Combined aarecords, elasticdump documents and Elasticsearch hit objects.
// Raw collection-specific AAC records need conversion to this combined schema.
export function mapRecord(document) {
  if (!document || typeof document !== 'object') return null;
  const raw = document._source || document;
  const data = raw.file_unified_data || raw;
  const identifiers = data.identifiers_unified || {};
  let id = raw.id || document._id || identifiers.aarecord_id?.[0] || raw.md5;
  const suppliedTitle = text(data.title_best) || text(data.title)
    || (Array.isArray(data.title_additional) ? data.title_additional.map(text).find(Boolean) : '');
  const combined = raw.file_unified_data && typeof raw.file_unified_data === 'object' && !Array.isArray(raw.file_unified_data);
  if (!id || (!suppliedTitle && !combined)) return null;
  // Real combined dumps contain identified, downloadable records without a
  // catalog title. Retain them (and their searchable ISBN/author) rather than
  // silently discarding them; never present a filename as a supplied title.
  const filename = text(data.original_filename_best) || text(data.original_filename);
  const title = suppliedTitle || filename.split(/[/\\]/).filter(Boolean).at(-1) || 'Untitled record';
  id = String(id);
  if (/^[a-f0-9]{32}$/i.test(id)) id = `md5:${id.toLowerCase()}`;
  const md5 = /^md5:([a-f0-9]{32})$/i.exec(id)?.[1]?.toLowerCase();
  if (md5) id = `md5:${md5}`;
  const isbn = [...new Set([...strings(identifiers.isbn13), ...strings(identifiers.isbn10), ...strings(data.isbn)]
    .map((s) => s.replace(/[\s-]/g, '').toUpperCase()))];
  return {
    id, title, ...(suppliedTitle ? {} : { titleIsFallback: true }), author: strings(data.author_best || data.author).join(', '),
    cover: data.cover_url_best || data.cover || null,
    summary: typeof data.stripped_description_best === 'string' ? data.stripped_description_best : '',
    year: String(data.year_best || data.year || ''), publisher: data.publisher_best || data.publisher || '',
    languages: strings(data.language_codes || data.languages || data.language),
    extension: data.extension_best || data.extension || '', filesize: Number(data.filesize_best || data.filesize) || 0,
    contentType: data.content_type_best || '', type: /comic/i.test(data.content_type_best || '') ? 'comic' : 'book', isbn,
    readUrl: md5 ? `${ANNA_ORIGIN}/md5/${md5}` : `${ANNA_ORIGIN}/search?${new URLSearchParams({ q: isbn[0] || title })}`,
    torrents: torrentReferences(raw, data), source: 'anna', sourceName: 'Anna’s Archive',
  };
}
export const search = async (text, offset = 0, type) => await catalogMode() === 'static' && connectedIndex()
  ? searchIndex(text, offset, type) : catalogRequest('anna/search', { q: text, offset, type });
export const status = async () => {
  const health = await catalogRequest('health'), index = connectedIndex();
  if (!health.static || !index) return health;
  return { ...health, annaRecords: index.records, remoteAnna: index, providers: { ...health.providers,
    anna: { status: 'ready', records: index.records, files: [], coverage: `TorBox index: ${index.shards.length}/12 combined metadata shards from ${index.snapshot}; ${index.complete ? 'complete selected snapshot' : 'partial index'}.` } } };
};
export async function importMetadata(file) {
  if (await catalogMode() === 'static') return (await import('./browser-metadata.js')).importBrowserMetadata(file);
  return catalogRequest('anna/import', { filename: file.name }, {
    method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' },
  });
}
