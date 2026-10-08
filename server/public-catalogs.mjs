// Public catalog metadata only; never scrape chapter files or protected endpoints.
export function plainText(value = '') {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
      const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }).replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, n) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[n])
    .replace(/\s+/g, ' ').trim();
}
const attr = (tag, name) => plainText(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i').exec(tag)?.[1] || '');
const https = (value, base) => { try { const url = new URL(value, base); return url.protocol === 'https:' ? url.href : null; } catch { return null; } };

export function parseComikey(html) {
  const items = [];
  for (const [, block] of html.matchAll(/<li\b[^>]*class=["'][^"']*\bitem-full-row\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)) {
    const heading = /<span\b[^>]*class="title"[^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1] || '';
    const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(heading);
    const readUrl = anchor && https(attr(anchor[1], 'href'), 'https://comikey.com');
    const title = anchor && plainText(anchor[2]);
    const id = readUrl && /\/(\d+)\/$/.exec(new URL(readUrl).pathname)?.[1];
    if (!id || !title || new URL(readUrl).hostname !== 'comikey.com') continue;
    const subtitle = /<span\b[^>]*class="subtitle"[^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1] || '';
    items.push({ id, title, author: plainText(subtitle).replace(/^by\s+/i, ''), readUrl,
      cover: https(attr(/<img\b[^>]*>/i.exec(block)?.[0] || '', 'src'), 'https://comikey.com'),
      source: 'comikey', sourceName: 'Comikey', type: 'manga', languages: ['en'],
      summary: 'Official publisher catalog. Free previews, chapter access and paid unlocks depend on the series.' });
  }
  return { items, next: /class="page-item next-page"/.test(html) };
}

export function parseWebtoon(html) {
  const items = [];
  for (const [, attributes, body] of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (!attr(attributes, 'class').split(/\s+/).includes('_originals_title_a')) continue;
    const id = attr(attributes, 'data-title-no');
    const readUrl = https(attr(attributes, 'href'), 'https://www.webtoons.com');
    const title = plainText(/<strong\b[^>]*class="title"[^>]*>([\s\S]*?)<\/strong>/i.exec(body)?.[1] || '');
    if (!/^\d+$/.test(id) || !title || !readUrl || new URL(readUrl).hostname !== 'www.webtoons.com') continue;
    items.push({ id, title, author: '', readUrl, source: 'webtoon', sourceName: 'WEBTOON', type: 'manga', languages: ['en'],
      cover: https(attr(/<img\b[^>]*>/i.exec(body)?.[0] || '', 'src'), 'https://www.webtoons.com'),
      summary: 'Read episodes on the official WEBTOON reader. Some early-access or archived episodes require coins.' });
  }
  return { items };
}
