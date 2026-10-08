import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { auditAnnaShard, auditAnnaCatalog } from '../server/audit-anna.mjs';
import { openAnnaStore } from '../server/anna-store.mjs';
import { mapRecord } from '../js/sources/anna.js';

test('Read-only shard audits reject skipped records, mismatched checkpoints and corrupt gzip streams', async () => {
  const valid = JSON.stringify({ id: 'audit-book', title: 'Audit fixture' }) + '\n';
  const audit = text => auditAnnaShard(Readable.from([Buffer.from(text)]), { filename: 'aarecords__0.json', expectedRecords: 1 });
  assert.deepEqual(await audit(valid), { records: 1, skipped: 0, counts: { book: 1, comic: 0 } });
  await assert.rejects(audit(valid + '{"collection_specific":{"raw":"unsupported"}}\n'), /every record/);
  await assert.rejects(auditAnnaShard(Readable.from([Buffer.from(valid)]), { filename: 'metadata.jsonl', expectedRecords: 2 }), /checkpoint/);
  const broken = gzipSync(valid); broken[broken.length - 1] ^= 1;
  await assert.rejects(auditAnnaShard(Readable.from([broken]), { filename: 'aarecords__0.json.gz', expectedRecords: 1 }));
});

test('Catalog audits explicitly distinguish partial coverage, verify all source hashes/types and leave the database unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ubr-source-audit-'));
  const sourcePath = join(directory, 'source.sqlite'), store = openAnnaStore(sourcePath);
  const plan = { snapshot: '20260208', hash: 'a'.repeat(40), root: 'fixture', files: [] };
  try {
    await mkdir(join(directory, plan.root, 'elasticsearch'), { recursive: true });
    for (let shard = 0; shard < 12; shard++) {
      const raw = shard === 11 ? { id: `audit-${shard}`, file_unified_data: { title_best: 'Comic fixture', content_type_best: 'comic' } }
        : { id: `audit-${shard}`, title: `Book fixture ${shard}` };
      const bytes = gzipSync(JSON.stringify(raw) + '\n'), name = `elasticsearch/aarecords__${shard}.json.gz`;
      await writeFile(join(directory, plan.root, name), bytes);
      plan.files.push({ shard, index: shard + 1, name, size: bytes.length });
      store.put(mapRecord(raw));
    }
    store.finishImport(`${plan.hash}:1`, 1);
    const args = { sourcePath, directory, plan };
    await assert.rejects(auditAnnaCatalog(args), /All 12/);
    const partial = await auditAnnaCatalog({ ...args, completedOnly: true });
    assert.equal(partial.complete, false); assert.equal(partial.shards.length, 1); assert.equal(partial.records, 1);
    for (const file of plan.files.slice(1)) store.finishImport(`${plan.hash}:${file.index}`, 1);
    const full = await auditAnnaCatalog(args);
    assert.equal(full.format, 'ubr-anna-source-audit'); assert.equal(full.complete, true);
    assert.equal(full.records, 12); assert.deepEqual(full.counts, { book: 11, comic: 1 });
    for (const proof of full.shards) {
      const bytes = await readFile(join(directory, plan.root, plan.files[proof.shard].name));
      assert.equal(proof.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(proof.skipped, 0); assert.equal(proof.records, 1);
    }
    assert.equal(store.total(), 12); assert.equal(store.search('fixture').total, 12);
    store.put(mapRecord({ id: 'not-in-selected-snapshot', title: 'Additional metadata' }));
    await assert.rejects(auditAnnaCatalog(args), /counts differ/);
    assert.equal(store.total(), 13, 'Failed audits must not remove or change records.');
    await assert.rejects(auditAnnaCatalog({ ...args, plan: { ...plan, root: '..' } }), /Invalid/);
    await assert.rejects(auditAnnaCatalog({ ...args, plan: { ...plan, files: plan.files.map((file, n) => n ? file : { ...file, name: '../../outside.json.gz' }) } }), /Invalid/);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
