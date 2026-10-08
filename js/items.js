// Library item helpers shared by the UI.
import * as db from './db.js';

const coverUrls = new Map();

export function coverSrc(item) {
  if (item.cover instanceof Blob) {
    if (!coverUrls.has(item.id)) coverUrls.set(item.id, URL.createObjectURL(item.cover));
    return coverUrls.get(item.id);
  }
  return item.coverUrl || null;
}

export async function removeItem(id) {
  await db.deleteItem(id);
  const url = coverUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  coverUrls.delete(id);
}

const remote = (fields) => ({
  addedAt: Date.now(),
  lastRead: 0,
  read: false,
  progress: { pct: 0, page: 0 },
  ...fields,
});

export const iaItem = (entry) => remote({
  id: `ia:${entry.id}`, type: 'comic', format: 'ia', iaId: entry.id, title: entry.title, coverUrl: entry.cover,
});

export const pseItem = (entry, sourceId) => remote({
  id: `pse:${sourceId}:${entry.id}`, type: 'comic', format: 'pse', sourceId, pse: entry.pse,
  title: entry.title, coverUrl: entry.thumb,
});

export const catalogItem = (entry) => remote({
  id: `catalog:${entry.source}:${entry.id}`, type: entry.source === 'anna' ? entry.type || 'book' : 'manga',
  format: 'catalog', title: entry.title, coverUrl: entry.cover, sourceName: entry.sourceName,
  catalogEntry: entry,
});

export const chapterItem = (series, chapter) => remote({
  id: `mangadex:${chapter.id}`, type: 'manga', format: 'mangadex', chapterId: chapter.id,
  title: `${series.title} · ${chapter.chapter ? `Ch. ${chapter.chapter}` : chapter.title || 'Oneshot'}`,
  seriesTitle: series.title, coverUrl: series.cover, sourceName: 'MangaDex', readUrl: chapter.readUrl,
  scanlationGroups: chapter.groups,
  mode: series.originalLanguage === 'ja' ? 'rtl' : 'vertical',
});

export async function ensureItem(item) {
  const existing = await db.getItem(item.id);
  if (existing) return existing;
  await db.putItem(item);
  return item;
}

export const DEFAULT_MODES = { comic: 'ltr', manga: 'rtl' };
