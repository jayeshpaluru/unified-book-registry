import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { searchExpression } from '../js/index/queries.js';
export { searchExpression } from '../js/index/queries.js';

export function openAnnaStore(filename = ':memory:', { cacheKiB = 65536 } = {}) {
  if (!Number.isSafeInteger(cacheKiB) || cacheKiB < 1024 || cacheKiB > 262144) throw new Error('Anna store cache must be between 1 and 256 MiB.');
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA cache_size = -${cacheKiB};
    CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL, isbn TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS books_title ON books(title, id);
    CREATE TABLE IF NOT EXISTS catalog_counts (key INTEGER PRIMARY KEY, total INTEGER NOT NULL);
    INSERT OR IGNORE INTO catalog_counts VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS metadata_imports (key TEXT PRIMARY KEY, records INTEGER NOT NULL, completed_at TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(title, author, isbn, content='books', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER IF NOT EXISTS books_insert AFTER INSERT ON books BEGIN
      INSERT INTO books_fts(rowid, title, author, isbn) VALUES (new.rowid, new.title, new.author, new.isbn);
      UPDATE catalog_counts SET total = total + 1 WHERE key = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS books_update AFTER UPDATE ON books BEGIN
      INSERT INTO books_fts(books_fts, rowid, title, author, isbn) VALUES ('delete', old.rowid, old.title, old.author, old.isbn);
      INSERT INTO books_fts(rowid, title, author, isbn) VALUES (new.rowid, new.title, new.author, new.isbn);
    END;
  `);
  if (!db.prepare('PRAGMA table_info(books)').all().some((column) => column.name === 'kind')) {
    db.exec(`ALTER TABLE books ADD COLUMN kind TEXT NOT NULL DEFAULT 'book';
      UPDATE books SET kind = CASE WHEN json_extract(data, '$.contentType') LIKE '%comic%' THEN 'comic' ELSE 'book' END;`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS books_kind_title ON books(kind, title, id)');
  const upsert = db.prepare(`INSERT INTO books (id, title, author, isbn, data, kind) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, author=excluded.author, isbn=excluded.isbn, data=excluded.data, kind=excluded.kind
    WHERE books.title IS NOT excluded.title OR books.author IS NOT excluded.author
      OR books.isbn IS NOT excluded.isbn OR books.data IS NOT excluded.data OR books.kind IS NOT excluded.kind`);
  const count = db.prepare('SELECT total FROM catalog_counts WHERE key = 1');
  return {
    put(record) { return upsert.run(record.id, record.title, record.author, record.isbn.join(' '), JSON.stringify(record), record.type || 'book'); },
    begin() { db.exec('BEGIN'); }, commit() { db.exec('COMMIT'); }, rollback() { db.exec('ROLLBACK'); },
    total() { return count.get().total; }, close() { db.close(); },
    configuration() { return { cacheKiB: -db.prepare('PRAGMA cache_size').get().cache_size,
      journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
      synchronous: db.prepare('PRAGMA synchronous').get().synchronous }; },
    completedImport(key) { return !!db.prepare('SELECT 1 FROM metadata_imports WHERE key = ?').get(key); },
    finishImport(key, records) { db.prepare('INSERT OR REPLACE INTO metadata_imports VALUES (?, ?, ?)').run(key, records, new Date().toISOString()); },
    search(query = '', { offset = 0, limit = 30, type } = {}) {
      const expression = searchExpression(query);
      if (query.trim() && !expression) return { items: [], total: 0, next: null };
      const kinds = ['book', 'comic'].includes(type) ? [type] : [];
      let total, rows;
      if (expression) {
        const where = `books_fts MATCH ?${kinds.length ? ' AND books.kind = ?' : ''}`;
        const args = [expression, ...kinds];
        total = db.prepare(`SELECT count(*) AS n FROM books_fts JOIN books ON books.rowid = books_fts.rowid WHERE ${where}`).get(...args).n;
        rows = db.prepare(`SELECT books.data FROM books_fts JOIN books ON books.rowid = books_fts.rowid
          WHERE ${where} ORDER BY bm25(books_fts), books.title, books.id LIMIT ? OFFSET ?`).all(...args, limit, offset);
      } else {
        const where = kinds.length ? 'WHERE kind = ?' : '';
        total = kinds.length ? db.prepare(`SELECT count(*) AS n FROM books ${where}`).get(...kinds).n : count.get().total;
        rows = db.prepare(`SELECT data FROM books ${where} ORDER BY title, id LIMIT ? OFFSET ?`).all(...kinds, limit, offset);
      }
      return { items: rows.map((r) => JSON.parse(r.data)), total, next: offset + limit < total ? offset + limit : null };
    },
  };
}
