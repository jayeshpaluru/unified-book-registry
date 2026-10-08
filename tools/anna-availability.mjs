import { createTorboxClient } from '../server/torbox.mjs';
import { torrentInfo } from '../server/torrent-metadata.mjs';

const source = 'https://annas-archive.pk/dyn/small_file/torrents/other_aa/aa_derived_mirror_metadata/aa_derived_mirror_metadata_20260208.torrent';
try {
  const response = await fetch(source, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Official metadata torrent returned HTTP ${response.status}.`);
  const info = torrentInfo(await response.arrayBuffer());
  const cached = await createTorboxClient(process.env.TORBOX_API_KEY).cached(info.hash);
  const present = Array.isArray(cached) ? cached.some((entry) => entry.hash === info.hash) : Boolean(cached?.[info.hash]);
  console.log(`Official metadata snapshot: ${(info.size / 1e12).toFixed(2)} TB total; ${info.files.filter((file) => /aarecords__\d+\.json\.gz$/.test(file.name)).length} combined-record data shards.`);
  console.log(`Snapshot currently in TorBox cache: ${present ? 'yes' : 'no'}.`);
  console.log('Read-only check. No torrent was added and no book payload was downloaded.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
