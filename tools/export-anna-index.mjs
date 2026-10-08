import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportAnnaIndex } from '../server/anna-index.mjs';
import { ANNA_SNAPSHOT } from '../server/anna-acquisition.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length > 2) throw new Error('Usage: npm run export:anna-index');
try {
  const plan = JSON.parse(await readFile(resolve(root, 'data/anna-metadata', ANNA_SNAPSHOT, 'plan.json'), 'utf8'));
  let lastLog = 0;
  const result = await exportAnnaIndex({ sourcePath: resolve(root, 'data/anna.sqlite'), plan,
    directory: resolve(root, 'data/anna-index'), onProgress: (progress) => {
      if (progress.stage !== 'copying' || Date.now() - lastLog > 15000) {
        console.log(progress.stage === 'copying' ? `Copying snapshot: ${progress.totalPages - progress.remainingPages}/${progress.totalPages} pages.`
          : `${progress.stage}: ${progress.records.toLocaleString()} metadata records.`); lastLog = Date.now();
      }
    } });
  console.log(`Verified metadata-only index: ${result.file} (${(result.receipt.bytes / 1e9).toFixed(2)} GB).`);
  console.log('Nothing uploaded. Keep this finalized file immutable; TorBox browser access must support CORS and HTTP byte ranges.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
