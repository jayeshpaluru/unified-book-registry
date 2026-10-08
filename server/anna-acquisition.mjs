export const ANNA_SNAPSHOT = '20260208';
export const ANNA_METADATA_TORRENT = `https://annas-archive.pk/dyn/small_file/torrents/other_aa/aa_derived_mirror_metadata/aa_derived_mirror_metadata_${ANNA_SNAPSHOT}.torrent`;

function safePath(path) {
  return typeof path === 'string' && path && !/[\\\x00-\x1f\x7f]/.test(path)
    && path.split('/').every((part) => part && part !== '.' && part !== '..');
}

// aria2 indexes the original torrent files from 1, not the filtered shard list.
export function metadataPlan(info, { expectedShards = 12, maxBytes = 200_000_000_000 } = {}) {
  if (!safePath(info.name) || info.name.includes('/') || !Array.isArray(info.files)
      || info.files.some((file) => !safePath(file.name) || !Number.isSafeInteger(file.size) || file.size < 0)) {
    throw new Error('Unsafe metadata torrent paths or lengths.');
  }
  const files = info.files.flatMap((file, index) => {
    const match = /(?:^|\/)aarecords__(\d+)\.json\.gz$/.exec(file.name);
    return match ? [{ ...file, index: index + 1, shard: Number(match[1]) }] : [];
  });
  const bytes = files.reduce((total, file) => total + file.size, 0);
  if (files.length !== expectedShards || new Set(files.map((file) => file.shard)).size !== expectedShards
      || files.some((file) => file.shard >= expectedShards || !file.size) || bytes > maxBytes) {
    throw new Error('Unexpected metadata shard set or size; acquisition stopped for review.');
  }
  return { snapshot: ANNA_SNAPSHOT, hash: info.hash, root: info.name, bytes, files,
    selection: files.map((file) => file.index).join(',') };
}

// Fast resume is opt-in and only for an unchanged, gracefully stopped download
// or the legacy completed-transfer state (which predates separate import status).
// aria2 still hashes every incoming BitTorrent piece; this skips only another
// full startup read of files whose verified-piece ledger has been preserved.
export function verifyPieceResume(plan, state, controlBytes) {
  const legacyDownloaded = state?.status === 'complete' && state.transferStatus === undefined
    && Number.isSafeInteger(state.completedBytes) && state.completedBytes >= plan.bytes
    && Array.isArray(state.importedShards) && state.importedShards.length < 12
    && new Set(state.importedShards).size === state.importedShards.length
    && state.importedShards.every((n) => Number.isSafeInteger(n) && n >= 0 && n < 12);
  if (!(state?.status === 'paused' || legacyDownloaded) || state.snapshot !== plan.snapshot || state.infoHash !== plan.hash
      || state.selectedBytes !== plan.bytes || !Number.isSafeInteger(state.pid) || state.pid < 1
      || !Number.isSafeInteger(state.aria2Pid) || state.aria2Pid < 1
      || !Number.isSafeInteger(controlBytes) || controlBytes < 32) {
    throw new Error('Verified-piece resume requires the matching paused acquisition (or legacy completed transfer) and its existing aria2 control file. Use the default integrity check if the files changed or the prior stop was not clean.');
  }
}

export function metadataFileReady(file, reported, downloadComplete = false) {
  if (!reported || Number(reported.index) !== file.index || !['true', true].includes(reported.selected)) return false;
  // BitTorrent file completion bytes can include/omit shared piece boundaries.
  // A complete selected download is authoritative; do not wait forever for an
  // estimated per-file byte count to equal the exact compressed file length.
  return downloadComplete || Number(reported.completedLength) === file.size;
}

export function verifiedShardRecords(result) {
  if (!result || !Number.isSafeInteger(result.imported) || result.imported < 0
      || result.skipped !== 0) {
    throw new Error('A selected metadata shard did not import every record. Its completion checkpoint must not be saved; review the unsupported records first.');
  }
  return result.imported;
}
