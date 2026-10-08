import { catalogRequest } from './catalog-api.js';
export const ORIGIN = 'https://mangadex.org';
const localized = (values = {}, language = 'en') => values[language] || values.en || Object.values(values)[0] || '';
export function mapManga(manga, language = 'en') {
  const a = manga.attributes || {};
  const relationships = manga.relationships || [];
  const cover = relationships.find((r) => r.type === 'cover_art')?.attributes?.fileName;
  return {
    id: manga.id, title: localized(a.title, language),
    author: [...new Set(relationships.filter((r) => ['author', 'artist'].includes(r.type))
      .map((r) => r.attributes?.name).filter(Boolean))].join(', '),
    cover: cover ? `https://uploads.mangadex.org/covers/${manga.id}/${encodeURIComponent(cover)}.256.jpg` : null,
    summary: localized(a.description, language), year: a.year || '',
    languages: a.availableTranslatedLanguages || [], originalLanguage: a.originalLanguage,
    status: a.status, readUrl: `${ORIGIN}/title/${manga.id}`, source: 'mangadex', sourceName: 'MangaDex',
  };
}
export function mapSearch(json, language = 'en') {
  return { total: json.total, items: json.data.map((m) => mapManga(m, language)),
    next: json.offset + json.limit < Math.min(json.total, 10000) ? json.offset + json.limit : null };
}
export function mapChapter(chapter) {
  const a = chapter.attributes || {};
  const groups = (chapter.relationships || []).filter((r) => r.type === 'scanlation_group')
    .map((r) => ({ id: r.id, name: r.attributes?.name || 'Unnamed group', url: `${ORIGIN}/group/${r.id}` }));
  return {
    id: chapter.id, volume: a.volume, chapter: a.chapter, title: a.title || '',
    language: a.translatedLanguage, pages: a.pages || 0, unavailable: Boolean(a.isUnavailable), groups,
    readUrl: `${ORIGIN}/chapter/${chapter.id}`, externalUrl: a.externalUrl || null, publishedAt: a.publishAt,
  };
}
export function mapFeed(json) {
  return { items: json.data.map(mapChapter).filter((c) => !c.unavailable && (c.pages > 0 || c.externalUrl)),
    next: json.offset + json.limit < Math.min(json.total, 10000) ? json.offset + json.limit : null };
}
export function mapPages(json) {
  const { chapter, baseUrl } = json;
  if (!chapter?.data?.length || !baseUrl) throw new Error('This chapter has no readable pages on MangaDex.');
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'https:') throw new Error('MangaDex returned an invalid image server.');
  return chapter.data.map((name) => `${origin.href.replace(/\/$/, '')}/data/${encodeURIComponent(chapter.hash)}/${encodeURIComponent(name)}`);
}
export async function search(text, offset = 0, language = 'en') {
  return mapSearch(await catalogRequest('mangadex/search', { q: text, offset, language }), language);
}
export async function chapters(id, offset = 0, language = 'en') {
  return mapFeed(await catalogRequest(`mangadex/manga/${encodeURIComponent(id)}/chapters`, { offset, language }));
}
export async function loadPages(id) { return mapPages(await catalogRequest(`mangadex/chapter/${encodeURIComponent(id)}/pages`)); }
