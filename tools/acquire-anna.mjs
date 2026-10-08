import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, open, unlink, statfs } from 'node:fs/promises';
import { statfsSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { torrentInfo } from '../server/torrent-metadata.mjs';
import { ANNA_METADATA_TORRENT, ANNA_SNAPSHOT, metadataPlan } from '../server/anna-acquisition.mjs';
import { openAnnaStore } from '../server/anna-store.mjs';
import { importAnna } from '../server/import-anna.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(root, 'data/anna-metadata', ANNA_SNAPSHOT);
const statusFile = resolve(directory, 'status.json');
const lockFile = resolve(directory, 'acquisition.lock');
const dbPath = resolve(root, 'data/anna.sqlite');
const RESERVE = 100n * 1024n ** 3n;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function ensureDisk() {
  const fs = statfsSync(directory, { bigint: true });
  if (fs.bavail * fs.bsize < RESERVE) throw new Error('Acquisition paused before consuming the last 100 GiB of disk. Partial data and committed imports are preserved.');
}

async function run() {
  if (process.argv.slice(2).some((arg) => arg !== '--plan')) throw new Error('Usage: npm run acquire:anna -- [--plan]');
  await mkdir(directory, { recursive: true });
  const response = await fetch(ANNA_METADATA_TORRENT, { signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw new Error(`Official metadata manifest returned HTTP ${response.status}.`);
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 8 * 1024 * 1024) throw new Error('Official torrent manifest exceeds its safety limit.');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const plan = metadataPlan(torrentInfo(bytes));
  if (plan.bytes !== 166_956_687_557) throw new Error('The pinned snapshot has changed; refusing an unreviewed transfer size.');
  console.log(`Metadata-only plan: ${plan.files.length} aarecord shards, ${(plan.bytes / 1e9).toFixed(2)} GB compressed. Other torrent files are not selected.`);
  console.log(`Snapshot: ${plan.snapshot}; info hash: ${plan.hash}.`);
  if (process.argv.includes('--plan')) return;
  const disk = await statfs(directory, { bigint: true });
  if (disk.bavail * disk.bsize < BigInt(plan.bytes) + RESERVE) throw new Error('Insufficient disk for the selected metadata plus the 100 GiB reserve.');
  let oldLock;
  try { oldLock = JSON.parse(await readFile(lockFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (oldLock) {
    if (alive(oldLock.pid) || alive(oldLock.aria2Pid)) throw new Error('A metadata acquisition process is already live. Monitor it rather than starting a duplicate.');
    await unlink(lockFile); // Only this task's verified-stale, generated lock.
  }
  const lock = await open(lockFile, 'wx', 0o600);
  let child, exitStatus, store, stopped = false, state;
  const stop = () => { stopped = true; child?.kill('SIGTERM'); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, snapshot: plan.snapshot, hash: plan.hash }));
    const torrentPath = resolve(directory, 'metadata.torrent');
    try {
      const previous = await readFile(torrentPath);
      if (!previous.equals(bytes)) throw new Error('Existing torrent manifest differs; refusing to overwrite it.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(torrentPath, bytes, { flag: 'wx' });
    }
    await writeFile(resolve(directory, 'plan.json'), JSON.stringify(plan, null, 2));
    const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port; await new Promise((done) => listener.close(done));
    const token = randomBytes(32).toString('hex');
    const gid = plan.hash.slice(0, 16);
    child = spawn(process.env.UBR_ARIA2_PATH || '/opt/homebrew/bin/aria2c', [
      '--no-conf=true', `--dir=${directory}`, `--select-file=${plan.selection}`, '--file-allocation=none',
      '--check-integrity=true', '--continue=true', '--auto-file-renaming=false', '--seed-time=0',
      '--bt-enable-lpd=false', '--bt-max-peers=80', '--max-download-limit=32M', '--max-upload-limit=256K',
      '--enable-rpc=true', '--rpc-listen-all=false', `--rpc-listen-port=${port}`, `--rpc-secret=${token}`,
      `--gid=${gid}`, '--auto-save-interval=30', '--show-console-readout=false', '--summary-interval=0', '--console-log-level=warn',
      `--log=${resolve(directory, 'aria2.log')}`, '--log-level=notice', torrentPath,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', () => { exitStatus = -1; });
    child.on('exit', (code) => { exitStatus = code ?? -1; });
    await lock.truncate(0);
    await lock.write(JSON.stringify({ pid: process.pid, aria2Pid: child.pid, snapshot: plan.snapshot, hash: plan.hash }), 0, 'utf8');
    store = openAnnaStore(dbPath);
    state = { snapshot: plan.snapshot, infoHash: plan.hash, pid: process.pid, aria2Pid: child.pid,
      selectedBytes: plan.bytes, completedBytes: 0, records: store.total(), importedShards: [], status: 'starting' };
    const save = async () => { state.updatedAt = new Date().toISOString(); await writeFile(statusFile, JSON.stringify(state, null, 2)); };
    async function rpc(method, params = []) {
      const r = await fetch(`http://127.0.0.1:${port}/jsonrpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'metadata', method: `aria2.${method}`, params: [`token:${token}`, ...params] }),
        signal: AbortSignal.timeout(10000) });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error('Metadata downloader is not ready.');
      return json.result;
    }
    let lastLog = 0;
    async function importReady(files) {
      for (const file of plan.files) {
        const key = `${plan.hash}:${file.index}`;
        if (store.completedImport(key)) {
          if (!state.importedShards.includes(file.shard)) state.importedShards.push(file.shard);
          continue;
        }
        const downloaded = files?.find((entry) => Number(entry.index) === file.index);
        if (!downloaded || Number(downloaded.completedLength) !== file.size) continue;
        const path = resolve(directory, plan.root, file.name);
        if (resolve(downloaded.path) !== path) throw new Error('Unexpected downloaded shard path.');
        ensureDisk(); state.status = 'importing'; state.currentShard = file.shard; await save();
        console.log(`Importing completed metadata shard ${file.shard + 1}/${plan.files.length} into local SQLite…`);
        let lastProgress = 0;
        const result = await importAnna(createReadStream(path), store, { filename: file.name, batchSize: 2000, onProgress: (progress) => {
          if (stopped) throw new Error('Acquisition stopped; committed metadata batches are preserved.');
          if (Date.now() - lastProgress > 15000) {
            ensureDisk(); lastProgress = Date.now();
            console.log(`Shard ${file.shard + 1}: ${progress.imported.toLocaleString()} imported; ${progress.total.toLocaleString()} catalog records.`);
          }
        } });
        store.finishImport(key, result.imported); state.importedShards.push(file.shard); state.records = store.total();
        delete state.currentShard; await save();
      }
    }
    while (!stopped) {
      ensureDisk();
      let status;
      try { status = await rpc('tellStatus', [gid, ['status', 'completedLength', 'downloadSpeed', 'connections', 'files', 'errorCode']]); }
      catch {
        if (exitStatus !== undefined) throw new Error(`Metadata downloader exited (${exitStatus}) before verification. See data/anna-metadata/${ANNA_SNAPSHOT}/aria2.log.`);
        await sleep(3000); continue;
      }
      state.status = status.status; state.completedBytes = Number(status.completedLength);
      state.downloadBytesPerSecond = Number(status.downloadSpeed); state.connections = Number(status.connections);
      await save();
      await importReady(status.files);
      if (Date.now() - lastLog > 30000) {
        console.log(`Metadata: ${(state.completedBytes / 1e9).toFixed(2)}/${(plan.bytes / 1e9).toFixed(2)} GB · ${(state.downloadBytesPerSecond / 1e6).toFixed(2)} MB/s · ${state.connections} peers · ${state.importedShards.length}/12 shards imported.`);
        lastLog = Date.now();
      }
      if (status.status === 'error') throw new Error(`Metadata download failed (code ${status.errorCode}); partial data is resumable.`);
      if (state.importedShards.length === plan.files.length) {
        state.status = 'complete'; await save();
        console.log(`Full selected metadata import complete: ${store.total().toLocaleString()} local catalog records.`);
        stop(); break;
      }
      await sleep(10000);
    }
    if (stopped && state.status !== 'complete') { state.status = 'paused'; await save(); }
  } catch (error) {
    if (state) { state.status = 'error'; state.error = error.message; await writeFile(statusFile, JSON.stringify(state, null, 2)); }
    throw error;
  } finally {
    child?.kill('SIGTERM');
    if (child && exitStatus === undefined) await Promise.race([once(child, 'exit'), sleep(5000)]);
    store?.close(); await lock.close();
    await unlink(lockFile);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}
run().catch((error) => { console.error(error.message); process.exitCode = 1; });
