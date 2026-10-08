import test from 'node:test';
import assert from 'node:assert/strict';
import { metadataPlan, verifyPieceResume, metadataFileReady, verifiedShardRecords, acquisitionFailureStatus } from '../server/anna-acquisition.mjs';
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
  const completed = { ...state, status: 'complete', completedBytes: plan.bytes + 16, importedShards: [8] };
  assert.doesNotThrow(() => verifyPieceResume(plan, completed, 64));
  for (const change of [{ completedBytes: 100 }, { transferStatus: 'active' }, { importedShards: [8, 8] }, { importedShards: [12] }, { importedShards: undefined }]) {
    assert.throws(() => verifyPieceResume(plan, { ...completed, ...change }, 64), /matching paused/);
  }
});

test('A complete selected torrent unblocks pinned shards when per-file piece counts differ from exact file lengths', () => {
  const file = { index: 2, size: 12345 };
  const reported = { index: '2', selected: 'true', completedLength: '12345' };
  assert.equal(metadataFileReady(file, reported), true);
  for (const completedLength of ['12000', '12500']) {
    const estimated = { ...reported, completedLength };
    assert.equal(metadataFileReady(file, estimated), false);
    assert.equal(metadataFileReady(file, estimated, true), true);
  }
  assert.equal(metadataFileReady(file, { ...reported, selected: false }, true), false);
  assert.equal(metadataFileReady(file, { ...reported, index: '3' }, true), false);
  assert.equal(metadataFileReady(file, undefined, true), false);
});

test('Selected snapshot shards cannot receive completion checkpoints when records were skipped', () => {
  const store = openAnnaStore();
  try {
    assert.equal(verifiedShardRecords({ imported: 42, skipped: 0 }), 42);
    assert.equal(verifiedShardRecords({ imported: 0, skipped: 0 }), 0);
    for (const result of [null, {}, { imported: 42 }, { imported: 42, skipped: 1 },
      { imported: 42, skipped: -1 }, { imported: -1, skipped: 0 }, { imported: 2 ** 53, skipped: 0 }]) {
      assert.throws(() => store.finishImport('incomplete', verifiedShardRecords(result)), /every record/);
      assert.equal(store.completedImport('incomplete'), false);
    }
    store.finishImport('complete', verifiedShardRecords({ imported: 42, skipped: 0 }));
    assert.equal(store.completedImport('complete'), true);
  } finally { store.close(); }
});

test('Only intentional aborts become resumable pauses, not corruption or idle failures', () => {
  const aborted = new Error('Import failed', { cause: Object.assign(new Error('Aborted'), { code: 'ABORT_ERR' }) });
  assert.equal(acquisitionFailureStatus(aborted, true), 'paused');
  assert.equal(acquisitionFailureStatus(aborted, false), 'error');
  assert.equal(acquisitionFailureStatus(new Error('Bad gzip checksum'), true), 'error');
  assert.equal(acquisitionFailureStatus(new DOMException('Stopped', 'AbortError'), true), 'paused');
  const cycle = new Error('Cycle'); cycle.cause = cycle;
  assert.equal(acquisitionFailureStatus(cycle, true), 'error');
});
