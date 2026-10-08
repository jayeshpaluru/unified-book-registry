import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { createGunzip, createZstdDecompress } from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mapRecord } from '../js/sources/anna.js';
import { openAnnaStore } from './anna-store.mjs';

const MAX_RECORD_BYTES = 32 * 1024 * 1024;

async function* lines(stream) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.write(chunk);
    let boundary;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      if (boundary > MAX_RECORD_BYTES) throw new Error('A metadata record exceeds 32 MB.');
      yield buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
    }
    if (buffer.length > MAX_RECORD_BYTES) throw new Error('A metadata record exceeds 32 MB.');
  }
  buffer += decoder.end();
  if (buffer.trim()) yield buffer;
}

const unpackJson = (json) => Array.isArray(json) ? json : json?.hits?.hits || [json];

// Each batch is atomic. A failed import preserves earlier committed batches;
// importing the same file again updates records without duplicating them.
export async function importAnna(stream, store, { filename = 'metadata.jsonl', batchSize = 500, onProgress = () => {} } = {}) {
  let input = Readable.from(stream);
  if (/\.gz$/i.test(filename)) input = input.compose(createGunzip());
  if (/\.zst$/i.test(filename)) input = input.compose(createZstdDecompress());
  const name = filename.replace(/\.(gz|zst)$/i, '');
  let imported = 0, skipped = 0, committed = 0, lineNumber = 0, pending = 0;
  store.begin();
  const put = (json) => {
    if (json && ['index', 'create', 'update', 'delete'].some((key) => Object.hasOwn(json, key)) && !json.file_unified_data && !json._source) return;
    const record = mapRecord(json);
    if (!record) { skipped++; return; }
    store.put(record); imported++;
    if (++pending >= batchSize) {
      store.commit(); committed = imported; pending = 0;
      onProgress({ imported, skipped, total: store.total() });
      store.begin();
    }
  };
  try {
    if (/\.json$/i.test(name)) {
      const decoder = new StringDecoder('utf8');
      let raw = '', bytes = 0;
      for await (const chunk of input) {
        bytes += chunk.length;
        if (bytes > MAX_RECORD_BYTES) throw new Error('JSON files are limited to 32 MB; use JSONL for larger exports.');
        raw += decoder.write(chunk);
      }
      raw += decoder.end();
      for (const record of unpackJson(JSON.parse(raw.replace(/^\uFEFF/, '')))) put(record);
    } else {
      for await (const line of lines(input)) {
        lineNumber++;
        const text = line.replace(/^\uFEFF/, '').trim();
        if (text) put(JSON.parse(text));
      }
    }
    if (!imported && skipped) throw new Error('No combined Anna’s Archive records found. Use an aarecord/Elasticsearch export; raw collection AAC and SQL dumps need conversion first.');
    store.commit();
    const result = { imported, skipped, total: store.total() };
    onProgress(result);
    return result;
  } catch (error) {
    store.rollback();
    throw new Error(`Import failed${lineNumber ? ` at line ${lineNumber}` : ''}: ${error.message} (${committed} records committed before this batch.)`, { cause: error });
  } finally { input.destroy(); }
}

export async function runImport(argv = process.argv.slice(2)) {
  let dbPath = resolve(process.env.UBR_ANNA_DB || fileURLToPath(new URL('../data/anna.sqlite', import.meta.url)));
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') {
      if (!argv[i + 1]) throw new Error('--db needs a database path.');
      dbPath = resolve(argv[++i]);
    } else if (argv[i] === '--help') {
      console.log('Usage: npm run import:anna -- [--db path] metadata.jsonl[.gz|.zst] ...\nImports combined aarecord or Elasticsearch JSON/JSONL exports.');
      return;
    } else if (argv[i].startsWith('-')) throw new Error(`Unknown option: ${argv[i]}`);
    else files.push(argv[i]);
  }
  if (!files.length) throw new Error('Pass at least one metadata file. See npm run import:anna -- --help.');
  const store = openAnnaStore(dbPath);
  try {
    for (const filename of files) {
      const result = await importAnna(createReadStream(filename), store, { filename });
      console.log(`${filename}: ${result.imported} imported, ${result.skipped} skipped; ${result.total} catalog records.`);
    }
  } finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runImport().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
