import { zipSync, strToU8 } from '../vendor/fflate.js';

export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
export function safeFilename(value, extension = '') {
  let name = String(value || 'download').normalize('NFC').replace(/[\\/<>:"|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '-').replace(/^\.+|[. ]+$/g, '').trim();
  name = name.slice(0, 160) || 'download';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(name)) name = `_${name}`;
  return extension && !name.toLowerCase().endsWith(`.${extension}`) ? `${name}.${extension}` : name;
}
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = safeFilename(filename); link.hidden = true;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
// Pick the destination while the user's click is still active. Stream to disk
// without buffering the whole file; browsers without this API retain a cap.
export async function saveRemoteFile(url, filename, { fetchImpl = fetch, signal, onProgress = () => {},
  picker = globalThis.showSaveFilePicker?.bind(globalThis), save = saveBlob } = {}) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Invalid download URL.');
  if (!picker) {
    const bytes = await readDownloadBytes(url, { fetchImpl, signal, onProgress });
    save(new Blob([bytes]), filename); return bytes.byteLength;
  }
  const handle = await picker({ suggestedName: safeFilename(filename) });
  const writable = await handle.createWritable();
  const idle = new AbortController(); let timer, reader, size = 0;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new Error('The file download made no progress for 60 seconds.')), 60000); };
  try {
    arm();
    const response = await fetchImpl(parsed.href, { signal: signal ? AbortSignal.any([signal, idle.signal]) : idle.signal,
      credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(`File download returned HTTP ${response.status}.`);
    if (!response.body) throw new Error('The source returned no file.');
    reader = response.body.getReader();
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read(); if (done) break;
      await writable.write(value); size += value.byteLength; arm(); onProgress(size);
    }
    if (!size) throw new Error('The source returned an empty file.');
    await writable.close(); return size;
  } catch (error) { await writable.abort().catch(() => {}); throw error; }
  finally { clearTimeout(timer); await reader?.cancel().catch(() => {}); }
}
export async function readDownloadBytes(url, { maxBytes = MAX_DOWNLOAD_BYTES, fetchImpl = fetch, signal, onProgress = () => {} } = {}) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Invalid download URL.');
  const response = await fetchImpl(parsed.href, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000), credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error(`File download returned HTTP ${response.status}.`);
  if (!response.body) throw new Error('The source returned no file.');
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body.cancel(); throw new Error('This file exceeds the 200 MB in-memory browser download limit.');
  }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('This file exceeds the in-memory browser download limit.');
      chunks.push(value); onProgress(size);
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (!size) throw new Error('The source returned an empty file.');
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
function imageExtension(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  const text = new TextDecoder().decode(bytes.subarray(0, 16));
  if (text.startsWith('GIF8')) return 'gif';
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'webp';
  if (text.slice(4, 8) === 'ftyp' && /avif|avis/.test(text.slice(8))) return 'avif';
  throw new Error('The image server returned a non-image response; no archive was saved.');
}
const xml = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
export async function chapterCbz(urls, { title = '', credits = '', fetchImpl = fetch, signal, maxBytes = 128 * 1024 * 1024, onProgress = () => {} } = {}) {
  if (!Array.isArray(urls) || !urls.length || urls.length > 2000) throw new Error('Invalid chapter page count.');
  const entries = {}; let total = 0;
  // Sequential downloads respect the image host and retain the original page order.
  for (const [index, url] of urls.entries()) {
    signal?.throwIfAborted();
    const bytes = await readDownloadBytes(url, { maxBytes: Math.min(32 * 1024 * 1024, maxBytes - total), fetchImpl, signal });
    total += bytes.length;
    entries[`${String(index + 1).padStart(4, '0')}.${imageExtension(bytes)}`] = [bytes, { level: 0 }];
    onProgress({ pages: index + 1, totalPages: urls.length, bytes: total });
  }
  entries['ComicInfo.xml'] = strToU8(`<?xml version="1.0" encoding="utf-8"?><ComicInfo><Title>${xml(title)}</Title><Notes>${xml(credits)}</Notes><PageCount>${urls.length}</PageCount></ComicInfo>`);
  return new Blob([zipSync(entries)], { type: 'application/vnd.comicbook+zip' });
}
