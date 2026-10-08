import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, mkdtemp, open, rename, writeFile, statfs } from 'node:fs/promises';
import { createReadStream, statfsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { indexManifest } from '../js/index/queries.js';

// Local export only. This module does not upload, seed or publish anything.
export async function exportAnnaIndex({ sourcePath, plan, directory, reserveBytes = 100n * 1024n ** 3n, onProgress = () => {} }) {
  if (!plan || !/^\d{8}$/.test(plan.snapshot || '') || !/^[a-f\d]{40}$/.test(plan.hash || '') || plan.files?.length !== 12
      || new Set(plan.files.map((file) => file.shard)).size !== 12 || new Set(plan.files.map((file) => file.index)).size !== 12
      || plan.files.some((file) => !Number.isSafeInteger(file.shard) || file.shard < 0 || file.shard > 11 || !Number.isSafeInteger(file.index) || file.index < 1)) throw new Error('Invalid metadata acquisition plan.');
  const source = new DatabaseSync(resolve(sourcePath), { readOnly: true });
  let target;
  try {
    const imported = source.prepare('SELECT key FROM metadata_imports').all().map(({ key }) => key);
    if (!plan.files.every((file) => imported.includes(`${plan.hash}:${file.index}`))) throw new Error('All 12 selected metadata shards must finish importing before exporting the full snapshot.');
    const pages = source.prepare('PRAGMA page_count').get().page_count;
    const pageSize = source.prepare('PRAGMA page_size').get().page_size;
    await mkdir(directory, { recursive: true });
    const disk = await statfs(directory, { bigint: true });
    if (disk.bavail * disk.bsize < BigInt(pages) * BigInt(pageSize) + reserveBytes) throw new Error('Not enough disk for a separate index snapshot plus the safety reserve. The source database was not changed.');
    const folder = await mkdtemp(join(resolve(directory), `${plan.snapshot}-`));
    const partial = join(folder, 'anna-index.partial.sqlite');
    const placeholder = await open(partial, 'wx', 0o600); await placeholder.close();
    await backup(source, partial, { rate: 2000, progress: ({ remainingPages, totalPages }) => {
      const disk = statfsSync(folder, { bigint: true });
      if (disk.bavail * disk.bsize < reserveBytes) throw new Error('Snapshot export stopped before consuming the safety reserve. Its partial copy and source are preserved.');
      onProgress({ stage: 'copying', remainingPages, totalPages });
    } });
    target = new DatabaseSync(partial);
    target.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    const counts = { book: 0, comic: 0 };
    for (const row of target.prepare('SELECT kind, count(*) AS records FROM books GROUP BY kind').all()) {
      if (!Object.hasOwn(counts, row.kind)) throw new Error('Unsupported record kind in the catalog snapshot.');
      counts[row.kind] = row.records;
    }
    const records = target.prepare('SELECT total FROM catalog_counts WHERE key = 1').get().total;
    if (!Number.isSafeInteger(records) || records < 1 || counts.book + counts.comic !== records) throw new Error('Invalid metadata record counts in the snapshot.');
    // Build compact per-kind postings only in the immutable export. The live
    // import schema and its original FTS row IDs are left untouched.
    target.exec(`CREATE VIRTUAL TABLE books_search_book USING fts5(title, author, isbn, content='', tokenize='unicode61 remove_diacritics 2');
      CREATE VIRTUAL TABLE books_search_comic USING fts5(title, author, isbn, content='', tokenize='unicode61 remove_diacritics 2');`);
    const maximum = target.prepare('SELECT max(rowid) AS rowid FROM books'); maximum.setReadBigInts(true);
    const last = maximum.get().rowid;
    const firstBoundary = target.prepare('SELECT rowid FROM books ORDER BY rowid LIMIT 1 OFFSET 49999'); firstBoundary.setReadBigInts(true);
    const nextBoundary = target.prepare('SELECT rowid FROM books WHERE rowid > ? ORDER BY rowid LIMIT 1 OFFSET 49999'); nextBoundary.setReadBigInts(true);
    let previous = null, indexed = 0;
    while (previous === null || previous < last) {
      const disk = statfsSync(folder, { bigint: true });
      if (disk.bavail * disk.bsize < reserveBytes) throw new Error('Search-index construction stopped before consuming the safety reserve. Its partial copy and source are preserved.');
      const end = (previous === null ? firstBoundary.get() : nextBoundary.get(previous))?.rowid ?? last;
      target.exec('BEGIN');
      try {
        for (const kind of ['book', 'comic']) {
          const result = target.prepare(`INSERT INTO books_search_${kind}(rowid, title, author, isbn)
            SELECT rowid, title, author, isbn FROM books NOT INDEXED WHERE ${previous === null ? '' : 'rowid > ? AND '}rowid <= ? AND kind = ?`)
            .run(...(previous === null ? [] : [previous]), end, kind);
          indexed += Number(result.changes);
        }
        target.exec('COMMIT');
      } catch (error) { target.exec('ROLLBACK'); throw error; }
      previous = end;
      onProgress({ stage: 'indexing', indexed, records });
    }
    for (const kind of ['book', 'comic']) {
      if (target.prepare(`SELECT count(*) AS records FROM books_search_${kind}`).get().records !== counts[kind]) throw new Error('Partitioned search counts do not match the metadata snapshot.');
    }
    const manifest = indexManifest({ format: 'ubr-anna-sqlite', version: 1, payload: 'metadata-only', complete: true,
      snapshot: plan.snapshot, infoHash: plan.hash, records, counts, searchLayout: 'partitioned-fts-v1',
      shards: plan.files.map((file) => file.shard).sort((a, b) => a - b), generatedAt: new Date().toISOString() });
    target.exec('CREATE TABLE IF NOT EXISTS anna_index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    target.prepare('INSERT OR REPLACE INTO anna_index_metadata VALUES (?, ?)').run('manifest', JSON.stringify(manifest));
    onProgress({ stage: 'verifying', records });
    if (target.prepare('PRAGMA quick_check').all().some((row) => row.quick_check !== 'ok')) throw new Error('The index snapshot failed SQLite verification. Its partial copy was preserved.');
    target.close(); target = null;
    const hash = createHash('sha256'); let bytes = 0;
    onProgress({ stage: 'hashing', records });
    for await (const chunk of createReadStream(partial)) { hash.update(chunk); bytes += chunk.length; }
    const file = join(folder, 'anna-index.sqlite');
    await rename(partial, file);
    const receipt = { ...manifest, file: 'anna-index.sqlite', bytes, sha256: hash.digest('hex') };
    await writeFile(join(folder, 'manifest.json'), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
    return { file, receipt };
  } finally { target?.close(); source.close(); }
}
