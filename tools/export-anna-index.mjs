import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportAnnaIndex } from '../server/anna-index.mjs';
import { auditAcquiredMetadata, auditProgress } from './audit-anna-metadata.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length > 2) throw new Error('Usage: npm run export:anna-index');
try {
  const { plan, receipt: audit } = await auditAcquiredMetadata({ onProgress: auditProgress() });
  if (!audit.complete) throw new Error('A complete source audit is required before exporting the full snapshot.');
  let lastLog = 0;
  const result = await exportAnnaIndex({ sourcePath: resolve(root, 'data/anna.sqlite'), plan,
    directory: resolve(root, 'data/anna-index'), onProgress: (progress) => {
      if (!['copying', 'indexing'].includes(progress.stage) || Date.now() - lastLog > 15000) {
        console.log(progress.stage === 'copying' ? `Copying snapshot: ${progress.totalPages - progress.remainingPages}/${progress.totalPages} pages.`
          : progress.stage === 'indexing' ? `Building search partitions: ${progress.indexed.toLocaleString()}/${progress.records.toLocaleString()} metadata records.`
          : `${progress.stage}: ${progress.records.toLocaleString()} metadata records.`); lastLog = Date.now();
      }
    } });
  console.log(`Verified metadata-only index: ${result.file} (${(result.receipt.bytes / 1e9).toFixed(2)} GB).`);
  console.log('Nothing uploaded. Keep this finalized file immutable; TorBox browser access must support CORS and HTTP byte ranges.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
