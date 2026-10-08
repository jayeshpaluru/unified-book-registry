import { catalogRequest, catalogMode } from './catalog-api.js';
import { ANNA_SOURCE_ORIGIN, torrentReferences } from './anna-downloads.js';
export const ANNA_ORIGIN = ANNA_SOURCE_ORIGIN;
const strings = (value) => (Array.isArray(value) ? value : value == null ? [] : [value])
  .filter((v) => typeof v === 'string' || typeof v === 'number').map(String).filter(Boolean);

// Combined aarecords, elasticdump documents and Elasticsearch hit objects.
// Raw collection-specific AAC records need conversion to this combined schema.
export function mapRecord(document) {
  if (!document || typeof document !== 'object') return null;
  const raw = document._source || document;
  const data = raw.file_unified_data || raw;
  const identifiers = data.identifiers_unified || {};
  let id = raw.id || document._id || identifiers.aarecord_id?.[0] || raw.md5;
  const title = data.title_best || data.title;
  if (!id || typeof title !== 'string' || !title.trim()) return null;
  id = String(id);
  if (/^[a-f0-9]{32}$/i.test(id)) id = `md5:${id.toLowerCase()}`;
  const md5 = /^md5:([a-f0-9]{32})$/i.exec(id)?.[1]?.toLowerCase();
  if (md5) id = `md5:${md5}`;
  const isbn = [...new Set([...strings(identifiers.isbn13), ...strings(identifiers.isbn10), ...strings(data.isbn)]
    .map((s) => s.replace(/[\s-]/g, '').toUpperCase()))];
  return {
    id, title: title.trim(), author: strings(data.author_best || data.author).join(', '),
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
export const search = (text, offset = 0, type) => catalogRequest('anna/search', { q: text, offset, type });
export const status = () => catalogRequest('health');
export async function importMetadata(file) {
  if (await catalogMode() === 'static') return (await import('./browser-metadata.js')).importBrowserMetadata(file);
  return catalogRequest('anna/import', { filename: file.name }, {
    method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' },
  });
}
