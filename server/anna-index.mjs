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
    const manifest = indexManifest({ format: 'ubr-anna-sqlite', version: 1, payload: 'metadata-only', complete: true,
      snapshot: plan.snapshot, infoHash: plan.hash, records, counts,
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
