// Shared, inert metadata parsing. Provider markup is never mounted or executed.
export function htmlText(value = '') {
  return String(value).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
      const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }).replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, n) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[n])
    .replace(/\s+/g, ' ').trim();
}
export const htmlAttr = (tag, name) => htmlText(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i').exec(tag)?.[1] || '');
export async function metadataJson(response, maxBytes = 8 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('Provider metadata exceeds the supported size.'); }
  if (!response.body) throw new Error('The provider returned no metadata.');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '', size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Provider metadata exceeds the supported size.');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); }
}
export function httpsUrl(value, base) {
  try {
    if (typeof value !== 'string' || !value.trim() || value.length > 8192) return null;
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.') ||
      /^\d+(?:\.\d+){3}$/.test(url.hostname) || url.hostname.includes(':') || /\.(?:local|localhost|internal)$/.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

const DOWNLOAD_LABELS = new Set(['DOWNLOAD NOW', 'MAIN SERVER', 'MEGA', 'MEDIAFIRE', 'PIXELDRAIN', 'VIKINGFILE', 'TERABOX', 'DATANODES', 'GOFILE']);
const FILE_HOSTS = new Set(['getcomics.org', 'mega.nz', 'mediafire.com', 'www.mediafire.com', 'pixeldrain.com',
  'vikingfile.com', '1024terabox.com', 'terabox.com', 'www.terabox.com', 'datanodes.to', 'gofile.io']);
export function getComicsDownloads(content) {
  const items = new Map();
  const html = String(content || '').replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const label = htmlText(match[2]).toUpperCase();
    if (!DOWNLOAD_LABELS.has(label)) continue;
    let href = htmlAttr(match[1], 'href');
    if (href.startsWith('http://getcomics.org/')) href = href.replace(/^http:/, 'https:');
    const url = httpsUrl(href, 'https://getcomics.org');
    if (!url || !FILE_HOSTS.has(new URL(url).hostname) || (new URL(url).hostname === 'getcomics.org' && !new URL(url).pathname.startsWith('/dls/'))) continue;
    if (!items.has(url)) items.set(url, { label, url });
    if (items.size >= 20) break;
  }
  return [...items.values()];
}
export function mapGetComics(post) {
  if (!Number.isSafeInteger(post?.id) || post.id < 1) throw new Error('Invalid GetComics record.');
  const title = htmlText(post.title?.rendered || '');
  if (!title) throw new Error('GetComics returned an untitled record.');
  const content = post.content?.rendered || '';
  const image = /<img\b[^>]*>/i.exec(content)?.[0] || '';
  return { id: String(post.id), title, type: 'comic', source: 'getcomics', sourceName: 'GetComics',
    year: /\((\d{4})\)/.exec(title)?.[1] || '',
    cover: httpsUrl(post._embedded?.['wp:featuredmedia']?.[0]?.source_url || htmlAttr(image, 'src'), 'https://getcomics.org'),
    readUrl: httpsUrl(post.link, 'https://getcomics.org'),
    summary: 'Comic archive catalog. Retrieve a supported file through TorBox, then import and read it here.',
    downloads: getComicsDownloads(content) };
}
