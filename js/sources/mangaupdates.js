import { catalogRequest } from './catalog-api.js';
export function mapSeries(series) {
  return {
    id: String(series.series_id), title: series.title,
    author: (series.authors || []).map((a) => a.name).filter(Boolean).join(', '),
    cover: series.image?.url?.thumb || series.image?.url?.original || null,
    summary: series.description || '', year: series.year || '', type: series.type, status: series.status || '',
    readUrl: series.url || `https://www.mangaupdates.com/series/${Number(series.series_id).toString(36)}`,
    source: 'mangaupdates', sourceName: 'MangaUpdates',
  };
}
export function mapSearch(json) {
  return { total: json.total_hits, items: json.results.map((r) => mapSeries(r.record)),
    next: json.page * json.per_page < json.total_hits ? json.page + 1 : null };
}
export function mapReleases(json) {
  return { items: json.results.map(({ record, metadata }) => ({
    id: record.id, title: metadata?.series?.title || record.title || '',
    chapter: record.chapter, volume: record.volume, date: record.release_date,
    groups: (record.groups || []).map((g) => ({ id: g.group_id, name: g.name,
      url: g.group_id ? `https://www.mangaupdates.com/groups/${Number(g.group_id).toString(36)}` : null })),
  })), next: json.page * json.per_page < json.total_hits ? json.page + 1 : null };
}
export async function search(text, page = 1) {
  return mapSearch(await catalogRequest('mangaupdates/search', { q: text, page }));
}
export async function releases(id, page = 1) {
  return mapReleases(await catalogRequest(`mangaupdates/series/${encodeURIComponent(id)}/releases`, { page }));
}
