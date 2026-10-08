import * as db from '../db.js';
import { mapRecord } from './anna.js';
const MAX = 32 * 1024 * 1024;

export async function importBrowserMetadata(file) {
  if (/\.zst$/i.test(file.name)) throw new Error('Use the local CLI to import Zstandard. Browser imports support JSON, JSONL and gzip.');
  let stream = file.stream();
  if (/\.gz$/i.test(file.name)) stream = stream.pipeThrough(new DecompressionStream('gzip'));
  const name = file.name.replace(/\.gz$/i, '');
  const lineDelimited = !/\.json$/i.test(name) || /aarecords(?:__\d+)?\.json$/i.test(name);
  let imported = 0, skipped = 0, buffer = '', pending = [];
  async function put(document) {
    if (['index', 'create', 'update', 'delete'].some((key) => Object.hasOwn(document || {}, key)) && !document._source && !document.file_unified_data) return;
    const record = mapRecord(document);
    if (!record) { skipped++; return; }
    pending.push(record); imported++;
    if (pending.length >= 500) { await db.putMany('annaRecords', pending); pending = []; }
  }
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      if (lineDelimited) {
        let boundary;
        while ((boundary = buffer.indexOf('\n')) >= 0) {
          if (boundary > MAX) throw new Error('A metadata record exceeds 32 MB.');
          const line = buffer.slice(0, boundary).replace(/^\uFEFF/, '').trim(); buffer = buffer.slice(boundary + 1);
          if (line) await put(JSON.parse(line));
        }
      }
      if (buffer.length > MAX) throw new Error('Use JSONL for large exports; JSON documents are limited to 32 MB.');
    }
    if (buffer.trim()) {
      const json = JSON.parse(buffer.replace(/^\uFEFF/, ''));
      const values = lineDelimited ? [json] : Array.isArray(json) ? json : json.hits?.hits || [json];
      for (const value of values) await put(value);
    }
    if (!imported && skipped) throw new Error('No combined aarecord metadata found. Raw AAC and SQL dumps need conversion.');
    await db.putMany('annaRecords', pending);
    return { imported, skipped, total: (await db.all('annaRecords')).length };
  } finally { await reader.cancel().catch(() => {}); }
}
