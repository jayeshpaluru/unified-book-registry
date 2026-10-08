import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { importAnna } from './import-anna.mjs';
import { verifiedShardRecords } from './anna-acquisition.mjs';

// A counter sink, not a second import. No catalog rows or checkpoints are written.
export async function auditAnnaShard(stream, { filename, expectedRecords, onProgress = () => {} }) {
  if (!Number.isSafeInteger(expectedRecords) || expectedRecords < 0) throw new Error('Invalid checkpoint record count.');
  let records = 0;
  const counts = { book: 0, comic: 0 };
  const counter = { begin() {}, commit() {}, rollback() {}, total() { return records; },
    put(record) {
      if (!Object.hasOwn(counts, record.type)) throw new Error('Unsupported record kind in source audit.');
      counts[record.type]++; records++;
    } };
  const result = await importAnna(stream, counter, { filename, batchSize: 20000, onProgress });
  if (verifiedShardRecords(result) !== expectedRecords) throw new Error('Source audit count differs from the committed shard checkpoint.');
  return { records, skipped: 0, counts };
}

function safePath(value) {
  return typeof value === 'string' && value && !/[\\\x00-\x1f\x7f]/.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..');
}

export async function auditAnnaCatalog({ sourcePath, directory, plan, completedOnly = false, onProgress = () => {} }) {
  if (!plan || !/^\d{8}$/.test(plan.snapshot || '') || !/^[a-f\d]{40}$/.test(plan.hash || '')
      || !safePath(plan.root) || plan.root.includes('/') || plan.files?.length !== 12
      || new Set(plan.files.map(file => file.shard)).size !== 12 || new Set(plan.files.map(file => file.index)).size !== 12
      || plan.files.some(file => !Number.isSafeInteger(file.shard) || file.shard < 0 || file.shard > 11
        || !Number.isSafeInteger(file.index) || file.index < 1 || !safePath(file.name)
        || !Number.isSafeInteger(file.size) || file.size < 1)) throw new Error('Invalid source audit plan.');
  const db = new DatabaseSync(resolve(sourcePath), { readOnly: true });
  try {
    const checkpoint = db.prepare('SELECT records, completed_at FROM metadata_imports WHERE key = ?');
    const selected = plan.files.flatMap(file => {
      const saved = checkpoint.get(`${plan.hash}:${file.index}`);
      return saved ? [{ file, saved }] : [];
    });
    if (!selected.length || !completedOnly && selected.length !== 12) throw new Error('All 12 selected metadata shards must finish before a full source audit. Use --completed for an explicitly partial audit.');
    const receipt = { format: 'ubr-anna-source-audit', version: 1, snapshot: plan.snapshot, infoHash: plan.hash,
      complete: selected.length === 12, records: 0, counts: { book: 0, comic: 0 }, shards: [] };
    for (const { file, saved } of selected) {
      const path = resolve(directory, plan.root, file.name);
      const before = await lstat(path);
      if (!before.isFile() || before.size !== file.size) throw new Error('A source audit shard is not a regular file with its pinned compressed length.');
      const hash = createHash('sha256');
      async function* bytes() { for await (const chunk of createReadStream(path)) { hash.update(chunk); yield chunk; } }
      const audited = await auditAnnaShard(bytes(), { filename: file.name, expectedRecords: saved.records,
        onProgress: progress => onProgress({ shard: file.shard, ...progress }) });
      const after = await lstat(path), current = checkpoint.get(`${plan.hash}:${file.index}`);
      if (!after.isFile() || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs
          || current?.records !== saved.records || current.completed_at !== saved.completed_at) throw new Error('The source or checkpoint changed during its audit. No verified receipt was produced.');
      receipt.records += audited.records;
      for (const kind of ['book', 'comic']) receipt.counts[kind] += audited.counts[kind];
      receipt.shards.push({ shard: file.shard, index: file.index, records: audited.records, skipped: 0,
        counts: audited.counts, compressedBytes: file.size, sha256: hash.digest('hex'), checkpointAt: saved.completed_at });
      onProgress({ shard: file.shard, stage: 'verified', imported: audited.records, skipped: 0 });
    }
    if (receipt.complete) {
      const counts = { book: 0, comic: 0 };
      for (const row of db.prepare('SELECT kind, count(*) AS records FROM books GROUP BY kind').all()) {
        if (!Object.hasOwn(counts, row.kind)) throw new Error('Unsupported database kind in source audit.');
        counts[row.kind] = row.records;
      }
      const total = db.prepare('SELECT total FROM catalog_counts WHERE key = 1').get().total;
      if (receipt.records !== total || ['book', 'comic'].some(kind => receipt.counts[kind] !== counts[kind])) {
        throw new Error('Full source counts differ from the database. Review missing/duplicate IDs or concurrent imports before exporting a complete snapshot.');
      }
    }
    receipt.generatedAt = new Date().toISOString();
    return receipt;
  } finally { db.close(); }
}
