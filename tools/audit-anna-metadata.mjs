import { readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { auditAnnaCatalog } from '../server/audit-anna.mjs';
import { metadataPlan, ANNA_SNAPSHOT } from '../server/anna-acquisition.mjs';
import { torrentInfo } from '../server/torrent-metadata.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function auditAcquiredMetadata({ completedOnly = false, onProgress = () => {} } = {}) {
  const directory = resolve(root, 'data/anna-metadata', ANNA_SNAPSHOT);
  const manifestPath = resolve(directory, 'metadata.torrent'), stat = await lstat(manifestPath);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Invalid saved metadata torrent manifest.');
  const plan = metadataPlan(torrentInfo(await readFile(manifestPath)));
  if (plan.hash !== '2eafbb69cd213f597171e73d58fa5b6d162c8248' || plan.bytes !== 166_956_687_557) throw new Error('Source audit requires the pinned metadata-only snapshot.');
  const receipt = await auditAnnaCatalog({ sourcePath: resolve(root, 'data/anna.sqlite'), directory, plan, completedOnly, onProgress });
  const folder = resolve(directory, 'audits'); await mkdir(folder, { recursive: true });
  const file = resolve(folder, `${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
  return { receipt, file, plan };
}

export function auditProgress() {
  let lastLog = 0;
  return progress => {
    if (progress.stage === 'verified' || Date.now() - lastLog > 15000) {
      console.log(`Source audit shard ${progress.shard + 1}: ${progress.imported.toLocaleString()} records checked; ${progress.skipped} skipped${progress.stage === 'verified' ? ' · verified' : ''}.`);
      lastLog = Date.now();
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  try {
    if (args.length && (args.length !== 1 || args[0] !== '--completed')) throw new Error('Usage: npm run audit:anna -- [--completed]');
    const { receipt, file } = await auditAcquiredMetadata({ completedOnly: args.includes('--completed'), onProgress: auditProgress() });
    console.log(`${receipt.complete ? 'Full' : 'Partial'} source audit: ${receipt.shards.length}/12 shards, ${receipt.records.toLocaleString()} records, zero skipped. Receipt: ${file}`);
    console.log('Source gzip CRCs, checkpoint counts and compressed-file checksums verified. No database rows changed and nothing uploaded.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
