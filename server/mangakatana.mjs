import { htmlAttr, htmlText, httpsUrl } from '../js/sources/public-metadata.js';

export const KATANA_ORIGIN = 'https://mangakatana.com';
export const KATANA_SERIES_ID = /^(?=.{1,220}$)[a-z0-9]+(?:-[a-z0-9]+)*\.\d{1,9}$/;
export const KATANA_CHAPTER_ID = /^(?=.{1,240}$)[a-z0-9]+(?:-[a-z0-9]+)*\.\d{1,9}~c\d{1,9}(?:\.\d{1,4})?$/;
const inert = (html) => String(html).replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');

function ownUrl(attrs) {
  const href = httpsUrl(htmlAttr(attrs, 'href'), KATANA_ORIGIN);
  return href && new URL(href).origin === KATANA_ORIGIN ? new URL(href) : null;
}
function directoryHtml(html) {
  const clean = inert(html), tags = /<\/?div\b[^>]*>/gi;
  let start, depth = 0;
  for (const match of clean.matchAll(tags)) {
    if (start === undefined) {
      if (!match[0].startsWith('</') && htmlAttr(match[0], 'id') === 'book_list') { start = match.index + match[0].length; depth = 1; }
    } else {
      depth += match[0].startsWith('</') ? -1 : 1;
      if (depth === 0) return clean.slice(start, match.index);
    }
  }
  throw new Error('The MangaKatana directory markup is unavailable.');
}
export function parseKatanaSeries(html) {
  const entries = new Map();
  for (const [, attrs, body] of directoryHtml(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const url = ownUrl(attrs), id = /^\/manga\/([^/]+)\/?$/.exec(url?.pathname || '')?.[1];
    if (!id || !KATANA_SERIES_ID.test(id)) continue;
    const image = /<img\b[^>]*>/i.exec(body)?.[0], previous = entries.get(id);
    const title = image ? '' : htmlText(body);
    // Covers and factual titles are separate anchors in the public directory.
    entries.set(id, { id, title: title && title.length <= 200 ? title : previous?.title || '',
      cover: (image && httpsUrl(htmlAttr(image, 'data-src') || htmlAttr(image, 'src'), KATANA_ORIGIN)) || previous?.cover,
      type: 'manga', source: 'mangakatana', sourceName: 'MangaKatana', languages: ['en'], readUrl: url.href,
      summary: 'English manga directory. Available chapters open in this app; image downloads depend on the host’s browser permissions.' });
  }
  return [...entries.values()].filter((entry) => entry.title);
}
export function parseKatanaChapters(html, seriesId) {
  if (!KATANA_SERIES_ID.test(seriesId)) throw new Error('Invalid MangaKatana series reference.');
  const entries = new Map();
  for (const [, attrs, body] of inert(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const url = ownUrl(attrs), match = /^\/manga\/([^/]+)\/(c\d{1,9}(?:\.\d{1,4})?)\/?$/.exec(url?.pathname || '');
    if (!match || match[1] !== seriesId) continue;
    const id = `${match[1]}~${match[2]}`, text = htmlText(body);
    const chapter = /(?:Chapter|Ch\.?)\s*(\d+(?:\.\d+)?)/i.exec(text)?.[1] || match[2].slice(1);
    if (!entries.has(id)) entries.set(id, { id, chapter, title: text.replace(/^(?:Chapter|Ch\.?)\s*\d+(?:\.\d+)?\s*:?\s*/i, '').slice(0, 120),
      groups: [], source: 'mangakatana', readUrl: url.href });
  }
  return [...entries.values()].sort((a, b) => Number(a.chapter) - Number(b.chapter));
}
export function parseKatanaPages(html) {
  // The normal, anonymous chapter HTML supplies this literal URL array.
  // Parse data only: never evaluate scripts, decrypt data or forge tokens.
  const body = /\bvar\s+thzq\s*=\s*\[([\s\S]*?)\]\s*;/.exec(String(html).replace(/<!--[\s\S]*?-->/g, ''))?.[1];
  if (!body) throw new Error('The provider returned no usable chapter page manifest.');
  const pages = [], literal = /\s*(['"])(https:\/\/[^'"\\\r\n]*)\1\s*(?:,|$)/y;
  let offset = 0;
  while (body.slice(offset).trim()) {
    literal.lastIndex = offset;
    const match = literal.exec(body);
    if (!match) throw new Error('The chapter page manifest is not a supported URL array.');
    const href = httpsUrl(match[2]);
    if (!href || !new URL(href).hostname.endsWith('.mangakatana.com')) throw new Error('The chapter returned an unsupported image host.');
    pages.push(href);
    if (pages.length > 2000) throw new Error('The provider returned too many chapter pages.');
    offset = literal.lastIndex;
  }
  if (!pages.length) throw new Error('The provider returned no usable chapter page manifest.');
  return { pages };
}
