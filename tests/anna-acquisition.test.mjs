import test from 'node:test';
import assert from 'node:assert/strict';
import { metadataPlan, verifyPieceResume } from '../server/anna-acquisition.mjs';
import { openAnnaStore } from '../server/anna-store.mjs';

const info = () => ({ name: 'public-metadata', hash: 'a'.repeat(40), files: [
  { name: 'mariadb/large.sql.gz', size: 1_000_000_000_000 },
  ...Array.from({ length: 12 }, (_, i) => ({ name: `elasticsearch/aarecords__${i}.json.gz`, size: 100 })),
  { name: 'elasticsearchaux/other.json.gz', size: 100_000_000_000 },
] });
test('Metadata acquisition selects only combined-record shards using original one-based torrent indexes', () => {
  const plan = metadataPlan(info());
  assert.equal(plan.bytes, 1200); assert.equal(plan.files.length, 12);
  assert.equal(plan.selection, '2,3,4,5,6,7,8,9,10,11,12,13');
  assert.ok(plan.files.every((file) => file.name.startsWith('elasticsearch/aarecords__')));
});
test('Acquisition refuses unexpected shard sets, excessive selected sizes and unsafe paths', () => {
  const missing = info(); missing.files.pop(); missing.files.pop();
  assert.throws(() => metadataPlan(missing), /Unexpected/);
  assert.throws(() => metadataPlan(info(), { maxBytes: 1000 }), /size/);
  const unsafe = info(); unsafe.files[0].name = '../outside.sql';
  assert.throws(() => metadataPlan(unsafe), /Unsafe/);
});
test('Completed shard checkpoints belong to the local SQLite catalog', () => {
  const store = openAnnaStore();
  try { assert.equal(store.completedImport('snapshot:1'), false); store.finishImport('snapshot:1', 42);
    assert.equal(store.completedImport('snapshot:1'), true); assert.equal(store.completedImport('snapshot:2'), false);
  } finally { store.close(); }
});

test('Verified-piece resume requires the same gracefully paused snapshot and an existing control file', () => {
  const plan = metadataPlan(info()), state = { status: 'paused', snapshot: plan.snapshot, infoHash: plan.hash, selectedBytes: plan.bytes, pid: 123, aria2Pid: 124 };
  assert.doesNotThrow(() => verifyPieceResume(plan, state, 64));
  for (const change of [{ status: 'active' }, { status: 'error' }, { snapshot: '20250101' }, { infoHash: 'b'.repeat(40) }, { selectedBytes: 1 }, { pid: 0 }, { aria2Pid: null }]) {
    assert.throws(() => verifyPieceResume(plan, { ...state, ...change }, 64), /matching paused/);
  }
  assert.throws(() => verifyPieceResume(plan, state, 0), /control file/);
});
