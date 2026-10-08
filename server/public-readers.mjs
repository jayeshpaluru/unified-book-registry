import { htmlText, htmlAttr, httpsUrl, mapGetComics } from '../js/sources/public-metadata.js';

export const READER_ORIGINS = { mangapill: 'https://mangapill.com', weebcentral: 'https://weebcentral.com' };
const NAMES = { mangapill: 'MangaPill', weebcentral: 'Weeb Central' };
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const inertMarkup = (html) => String(html).replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
function checkId(provider, id, chapter = false) {
  const valid = provider === 'mangapill' ? (chapter ? /^\d{1,9}-\d{1,15}$/ : /^\d{1,9}$/).test(id) : ULID.test(id);
  if (!READER_ORIGINS[provider] || !valid) throw new Error('Invalid manga provider reference.');
}
export function parseReaderSeries(provider, html) {
  const origin = READER_ORIGINS[provider];
  if (!origin) throw new Error('Unknown manga provider.');
  const entries = new Map();
  for (const [, attrs, body] of inertMarkup(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = httpsUrl(htmlAttr(attrs, 'href'), origin);
    if (!href || new URL(href).origin !== origin) continue;
    const match = (provider === 'mangapill' ? /^\/manga\/(\d{1,9})(?:\/[^?]*)?$/ : /^\/series\/([0-9A-HJKMNP-TV-Z]{26})(?:\/[^?]*)?$/).exec(new URL(href).pathname);
    if (!match) continue;
    const image = /<img\b[^>]*>/i.exec(body)?.[0] || '';
    const alt = htmlAttr(image, 'alt').replace(/\s+cover$/i, '').replace(/^(.+?) \1$/, '$1');
    const text = htmlText(body);
    const title = !image && text.length <= 200 ? text : alt;
    const previous = entries.get(match[1]);
    if (!title && !previous) continue;
    entries.set(match[1], { ...previous, id: match[1], title: title || previous.title,
      cover: httpsUrl(htmlAttr(image, 'data-src') || htmlAttr(image, 'src'), origin) || previous?.cover,
      source: provider, sourceName: NAMES[provider], type: 'manga', languages: ['en'], readUrl: href,
      summary: 'English manga and scanlation catalog. Available chapters open in this app.' });
  }
  return [...entries.values()];
}
export function parseReaderChapters(provider, html) {
  const origin = READER_ORIGINS[provider];
  if (!origin) throw new Error('Unknown manga provider.');
  const entries = new Map();
  for (const [, attrs, body] of inertMarkup(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = httpsUrl(htmlAttr(attrs, 'href'), origin);
    if (!href || new URL(href).origin !== origin) continue;
    const match = (provider === 'mangapill' ? /^\/chapters\/(\d{1,9}-\d{1,15})(?:\/[^?]*)?$/ : /^\/chapters\/([0-9A-HJKMNP-TV-Z]{26})$/).exec(new URL(href).pathname);
    if (!match) continue;
    const text = htmlText(body), chapter = /(?:Chapter|Ch\.?)\s*(\d+(?:\.\d+)?)/i.exec(text)?.[1] ?? null;
    if (!chapter && !/oneshot|one-shot|extra|special/i.test(text)) continue;
    if (!entries.has(match[1])) entries.set(match[1], { id: match[1], chapter, title: chapter ? '' : text.slice(0, 120),
      groups: [], source: provider, readUrl: href });
  }
  return [...entries.values()].sort((a, b) => a.chapter !== null && b.chapter !== null ? Number(a.chapter) - Number(b.chapter) : 0);
}
export function parseReaderPages(provider, html) {
  const origin = READER_ORIGINS[provider], pages = [];
  if (!origin) throw new Error('Unknown manga provider.');
  for (const [tag] of inertMarkup(html).matchAll(/<img\b[^>]*>/gi)) {
    const isPage = provider === 'mangapill' ? htmlAttr(tag, 'class').split(/\s+/).includes('js-page') : /^Page\s+\d+$/i.test(htmlAttr(tag, 'alt'));
    if (!isPage) continue;
    const url = httpsUrl(htmlAttr(tag, 'data-src') || htmlAttr(tag, 'src'), origin);
    if (url && !pages.includes(url)) pages.push(url);
  }
  if (!pages.length || pages.length > 2000) throw new Error('The provider returned no usable chapter page manifest.');
  return { pages };
}

export function createPublicReaderClient({ fetchImpl = fetch } = {}) {
  const cache = new Map();
  async function text(url, headers = {}) {
    const key = url.href || String(url), previous = cache.get(key);
    if (previous?.expires > Date.now()) return previous.value;
    const origin = new URL(key).origin;
    let target = key, response;
    for (let count = 0; count < 4; count++) {
      response = await fetchImpl(target, { headers, signal: AbortSignal.timeout(25000), redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const next = httpsUrl(response.headers.get('location'), target);
      await response.body?.cancel();
      if (!next || new URL(next).origin !== origin) throw new Error('The public provider redirected to an unsupported origin.');
      target = next;
    }
    if (!response.ok) throw new Error(`The public provider returned HTTP ${response.status}.`);
    if (Number(response.headers.get('content-length')) > MAX_METADATA_BYTES) { await response.body?.cancel(); throw new Error('Provider metadata exceeds the supported size.'); }
    if (!response.body) throw new Error('The provider returned no metadata.');
    const reader = response.body.getReader(), decoder = new TextDecoder(); let value = '', size = 0;
    try {
      while (true) {
        const { value: bytes, done } = await reader.read(); if (done) break;
        size += bytes.length;
        if (size > MAX_METADATA_BYTES) throw new Error('Provider metadata exceeds the supported size.');
        value += decoder.decode(bytes, { stream: true });
      }
      value += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
    if (cache.size >= 8) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: Date.now() + 60000 });
    return value;
  }
  async function getComicsPost(id) {
    if (!/^\d{1,10}$/.test(String(id)) || Number(id) < 1) throw new Error('Invalid GetComics post ID.');
    const raw = JSON.parse(await text(new URL(`https://getcomics.org/wp-json/wp/v2/posts/${id}?_fields=id,title,link,content`)));
    if (raw.id !== Number(id)) throw new Error('The comic provider returned an unexpected post.');
    return mapGetComics(raw);
  }
  return {
    getComicsPost,
    async search(provider, q = '', page = 1) {
      if (!READER_ORIGINS[provider] || !Number.isSafeInteger(page) || page < 1 || page > 10000 || q.length > 300) throw new Error('Invalid manga search.');
      const url = new URL(provider === 'mangapill' ? '/search' : '/search/data', READER_ORIGINS[provider]);
      url.search = new URLSearchParams(provider === 'mangapill' ? { q, type: 'manga', page } :
        { text: q, sort: q ? 'Best Match' : 'Popularity', order: 'Descending', adult: 'False', display_mode: 'Full Display', offset: (page - 1) * 32, limit: 32 });
      const html = await text(url, provider === 'weebcentral' ? { 'HX-Request': 'true' } : {});
      const items = parseReaderSeries(provider, html);
      const next = provider === 'weebcentral' ? items.length === 32 : /rel=["']next["']/.test(html) || new RegExp(`[?&](?:amp;)?page=${page + 1}(?:[&"'])`).test(html);
      return { items, total: items.length, next: next ? page + 1 : null };
    },
    async chapters(provider, id, offset = 0) {
      checkId(provider, id);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new Error('Invalid chapter offset.');
      const url = new URL(provider === 'mangapill' ? `/manga/${id}` : `/series/${id}/full-chapter-list`, READER_ORIGINS[provider]);
      const items = parseReaderChapters(provider, await text(url));
      return { items: items.slice(offset, offset + 100), total: items.length, next: offset + 100 < items.length ? offset + 100 : null };
    },
    async pages(provider, id) {
      checkId(provider, id, true);
      const url = new URL(provider === 'mangapill' ? `/chapters/${id}` : `/chapters/${id}/images?is_prev=False&reading_style=long_strip`, READER_ORIGINS[provider]);
      return parseReaderPages(provider, await text(url, provider === 'weebcentral' ? { 'HX-Request': 'true' } : {}));
    },
  };
}

const LINK_HOSTS = ['getcomics.org', 'comicfiles.ru', 'pixeldrain.com', 'vikingfile.com', 'mega.nz', 'mediafire.com', '1024terabox.com', 'terabox.com', 'datanodes.to', 'gofile.io'];
function allowedFileUrl(value, base) {
  const href = httpsUrl(value, base);
  if (!href || !LINK_HOSTS.some((host) => new URL(href).hostname === host || new URL(href).hostname.endsWith(`.${host}`))) throw new Error('Unsupported comic file host.');
  return href;
}
export async function resolveGetComicsDownload(postId, index, { fetchImpl = fetch, expectedUrl } = {}) {
  const post = await createPublicReaderClient({ fetchImpl }).getComicsPost(postId);
  if (!Number.isSafeInteger(index) || index < 0 || index >= post.downloads.length) throw new Error('Invalid comic file selection.');
  if (expectedUrl && expectedUrl !== post.downloads[index].url) throw new Error('The provider changed this archive link. Refresh the catalog before submitting it.');
  let url = allowedFileUrl(post.downloads[index].url);
  // Follow only trusted public HEAD redirects. No comic bytes are fetched here.
  for (let count = 0; count < 6; count++) {
    const response = await fetchImpl(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(20000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) { url = allowedFileUrl(response.headers.get('location'), url); continue; }
    if (!response.ok) throw new Error(`The comic file host returned HTTP ${response.status}.`);
    if (Number(response.headers.get('content-length')) > 1e12) throw new Error('This comic archive exceeds the supported TorBox file size.');
    return { url, title: post.title, host: new URL(url).hostname };
  }
  throw new Error('The comic file host returned too many redirects.');
}
