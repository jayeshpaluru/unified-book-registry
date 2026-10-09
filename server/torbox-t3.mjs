// Actions/server only. TorBox T3 uses the Auth ID as its S3 access key ID,
// and the API key as the signing secret. The secret never enters returned URLs.
// Signature v2 is the compatibility mode recommended in TorBox's T3 guide.
// https://support.torbox.app/en/articles/15531689-torbox-t3
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/RESTAuthentication.html
import { createHmac } from 'node:crypto';

const ORIGIN = 'https://t3.nexus';
const MAX_XML = 2 * 1024 * 1024;
const encode = (text) => encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
function objectPath(bucket, key = '') {
  if (typeof bucket !== 'string' || !/^[a-z\d][a-z\d._-]{0,127}$/i.test(bucket)) throw new Error('Invalid T3 bucket.');
  if (typeof key !== 'string' || key.length > 4096 || /[\x00-\x1f\x7f\\]/.test(key) || key.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('Invalid T3 file reference.');
  }
  return `/${encode(bucket)}${key ? `/${key.split('/').map(encode).join('/')}` : ''}`;
}

export function createTorboxT3(authId, apiKey, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  if (typeof authId !== 'string' || !/^[A-Za-z\d_-]{8,128}$/.test(authId) || typeof apiKey !== 'string' || !apiKey.trim() || authId === apiKey.trim()) {
    throw new Error('TorBox T3 requires a valid Auth ID and server-side API key.');
  }
  apiKey = apiKey.trim();
  function signedUrl(path, params = {}) {
    const expires = Math.floor(now() / 1000) + 1800;
    if (!Number.isSafeInteger(expires) || expires <= 0) throw new Error('Invalid T3 signature timestamp.');
    const signature = createHmac('sha1', apiKey).update(`GET\n\n\n${expires}\n${path}`).digest('base64');
    const url = new URL(path, ORIGIN);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
    url.searchParams.set('AWSAccessKeyId', authId); url.searchParams.set('Expires', String(expires)); url.searchParams.set('Signature', signature);
    if (decodeURIComponent(url.href).includes(apiKey)) throw new Error('An unsafe T3 link was rejected before leaving Actions.');
    return url.href;
  }
  async function xml(path, params) {
    let response;
    try { response = await fetchImpl(signedUrl(path, params), { credentials: 'omit', redirect: 'error',
      signal: AbortSignal.timeout(30000), headers: { Accept: 'application/xml' } }); }
    catch { throw new Error('TorBox T3 could not be reached.'); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`TorBox T3 returned HTTP ${response.status}.`); }
    if (Number(response.headers.get('content-length')) > MAX_XML) { await response.body?.cancel().catch(() => {}); throw new Error('TorBox T3 returned an excessive file list.'); }
    if (!response.body) throw new Error('TorBox T3 returned no file list.');
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0, text = '';
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_XML) throw new Error('TorBox T3 returned an excessive file list.');
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (/<!DOCTYPE|<!ENTITY/i.test(text) || !/^\s*(?:<\?xml[^>]*>\s*)?</.test(text)) throw new Error('TorBox T3 returned an invalid XML file list.');
    return text;
  }
  return {
    async buckets() {
      const body = await xml('/');
      if (!/<ListAllMyBucketsResult(?:\s|>)/.test(body)) throw new Error('TorBox T3 returned an invalid bucket list.');
      const buckets = elements(body, 'Bucket').map((entry) => xmlText(elements(entry, 'Name')[0] || ''));
      if (buckets.length > 256) throw new Error('TorBox T3 exceeds the diagnostic bucket limit.');
      return buckets;
    },
    async files(bucket) {
      const body = await xml(objectPath(bucket), { 'max-keys': 1000, 'encoding-type': 'url' });
      if (!/<ListBucketResult(?:\s|>)/.test(body)) throw new Error('TorBox T3 returned an invalid file list.');
      const encoded = xmlText(elements(body, 'EncodingType')[0] || '') === 'url';
      const files = elements(body, 'Contents').map((entry) => {
        let key = xmlText(elements(entry, 'Key')[0] || '');
        if (encoded) { try { key = decodeURIComponent(key); } catch { throw new Error('TorBox T3 returned an invalid file reference.'); } }
        objectPath(bucket, key);
        const sizeText = xmlText(elements(entry, 'Size')[0] || '');
        const size = /^\d+$/.test(sizeText) ? Number(sizeText) : NaN;
        if (!key || !Number.isSafeInteger(size)) throw new Error('TorBox T3 returned an invalid file reference.');
        return { key, size };
      });
      if (files.length > 1000) throw new Error('TorBox T3 exceeds the diagnostic file-list limit.');
      return files;
    },
    download: (bucket, key) => { if (!key) throw new Error('Select a T3 file, not a bucket.'); return signedUrl(objectPath(bucket, key)); },
  };
}

// Only literal XML scalar values are parsed, with no DTD or entity expansion.
function elements(text, name) {
  return [...text.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'g'))].map((match) => match[1]);
}
function xmlText(text) {
  if (text.includes('<') || /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/i.test(text)) throw new Error('TorBox T3 returned an invalid XML value.');
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (_, entity) => {
    if (entity.startsWith('#')) {
      const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!Number.isSafeInteger(point) || point <= 0 || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) throw new Error('TorBox T3 returned an invalid XML character.');
      return String.fromCodePoint(point);
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()];
  });
}

// Diagnostic sampling is deliberately bounded, not a claim of full T3 coverage.
export async function probeTorboxT3(apiClient, apiKey, options) {
  const account = await apiClient.account();
  const client = createTorboxT3(account?.auth_id, apiKey, options);
  const buckets = await client.buckets();
  buckets.sort((a, b) => Number(b === 'torbox') - Number(a === 'torbox'));
  for (const bucket of buckets.slice(0, 16)) {
    const file = (await client.files(bucket)).find((entry) => entry.size >= 4096 && !entry.key.endsWith('/'));
    if (file) return { url: client.download(bucket, file.key), kind: 't3', fileSize: file.size };
  }
  throw new Error('No usable file was found in the bounded read-only T3 sample.');
}
