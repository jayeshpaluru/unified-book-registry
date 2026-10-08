import SQLiteFactory from '../../vendor/wa-sqlite/runtime/wa-sqlite-async.mjs';
import * as SQLite from '../../vendor/wa-sqlite/src/sqlite-api.js';
import { RangeReader } from '../index/range-reader.js';
import { HttpReadonlyVFS } from '../index/http-vfs.js';
import { searchStatements, indexManifest } from '../index/queries.js';

let reader, sqlite, db, manifest;
async function rows(sql, bindings = []) {
  const result = [];
  for await (const statement of sqlite.statements(db, sql)) {
    sqlite.bind_collection(statement, bindings);
    while (await sqlite.step(statement) === SQLite.SQLITE_ROW) result.push(sqlite.row(statement));
  }
  return result;
}
async function connect({ url, size }) {
  if (db) throw new Error('Disconnect the previous index first.');
  reader = new RangeReader(url, { expectedSize: size });
  const header = await reader.read(0, 100);
  if (new TextDecoder().decode(header.subarray(0, 16)) !== 'SQLite format 3\0' || header[18] !== 1 || header[19] !== 1) throw new Error('Choose a finalized single-file SQLite snapshot, not a gzip dump or active WAL database.');
  const module = await SQLiteFactory({ locateFile: (name) => new URL(`../../vendor/wa-sqlite/runtime/${name}`, import.meta.url).href,
    print: () => {}, printErr: () => {} });
  sqlite = SQLite.Factory(module);
  sqlite.vfs_register(new HttpReadonlyVFS(module, reader));
  db = await sqlite.open_v2('/anna.sqlite', SQLite.SQLITE_OPEN_READONLY, 'anna-http-readonly');
  sqlite.progress_handler(db, 10000, () => Date.now() > reader.budget.deadline ? 1 : 0);
  await sqlite.exec(db, 'PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-8192');
  const values = await rows("SELECT value FROM anna_index_metadata WHERE key = 'manifest'");
  manifest = indexManifest(JSON.parse(values[0]?.[0] || 'null'));
  return { manifest, stats: reader.stats() };
}
async function search({ query = '', offset = 0, type }) {
  if (!db || !manifest) throw new Error('Connect an index first.');
  reader.beginQuery(); const limit = 30, sql = searchStatements(query, { offset, limit, type });
  if (sql.empty) return { items: [], total: 0, next: null, stats: reader.stats() };
  const total = sql.count ? (await rows(sql.count, sql.countArgs))[0][0] : type ? manifest.counts[type] : manifest.records;
  const items = (await rows(sql.rows, sql.rowArgs)).map(([data]) => JSON.parse(data));
  return { items, total, next: offset + limit < total ? offset + limit : null, stats: reader.stats() };
}
let queue = Promise.resolve();
self.onmessage = ({ data: { id, action, params } }) => {
  queue = queue.then(async () => {
    try {
      const value = action === 'connect' ? await connect(params) : action === 'search' ? await search(params) : (() => { throw new Error('Unsupported index operation.'); })();
      self.postMessage({ id, value });
    } catch (error) { self.postMessage({ id, error: reader?.error || (error.code === SQLite.SQLITE_INTERRUPT ? 'Index query timed out. Use a more specific search.' : error.message.slice(0, 300)) }); }
  });
};
