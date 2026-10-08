export function searchExpression(query) {
  let text = query.trim().normalize('NFKC');
  if (/^[\dXx\s-]+$/.test(text) && [10, 13].includes(text.replace(/[\s-]/g, '').length)) text = text.replace(/[\s-]/g, '');
  return (text.match(/[\p{L}\p{N}]+/gu) || []).slice(0, 20).map((term) => `"${term}"*`).join(' AND ');
}
export function searchStatements(query = '', { offset = 0, limit = 30, type, searchLayout } = {}) {
  if (typeof query !== 'string' || query.length > 300 || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || type && !['book', 'comic'].includes(type)
      || searchLayout !== undefined && searchLayout !== 'partitioned-fts-v1') throw new Error('Invalid index search.');
  const expression = searchExpression(query), kinds = type ? [type] : [];
  if (query.trim() && !expression) return { empty: true };
  if (expression) {
    if (searchLayout === 'partitioned-fts-v1') {
      // Fixed table names only. Count compact postings, then read metadata for
      // one page, rather than joining/sorting every matching large JSON row.
      const table = type === 'book' ? 'books_search_book' : type === 'comic' ? 'books_search_comic' : 'books_fts';
      return { count: `SELECT count(*) FROM ${table} WHERE ${table} MATCH ?`, countArgs: [expression],
        rows: `WITH matches AS MATERIALIZED (SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid LIMIT ? OFFSET ?)
          SELECT books.data FROM matches JOIN books ON books.rowid = matches.rowid ORDER BY matches.rowid`,
        rowArgs: [expression, limit, offset] };
    }
    const where = `books_fts MATCH ?${type ? ' AND books.kind = ?' : ''}`;
    return { count: `SELECT count(*) FROM books_fts JOIN books ON books.rowid = books_fts.rowid WHERE ${where}`,
      countArgs: [expression, ...kinds],
      rows: `SELECT books.data FROM books_fts JOIN books ON books.rowid = books_fts.rowid WHERE ${where} ORDER BY bm25(books_fts), books.title, books.id LIMIT ? OFFSET ?`,
      rowArgs: [expression, ...kinds, limit, offset] };
  }
  return { rows: `SELECT data FROM books${type ? ' WHERE kind = ?' : ''} ORDER BY title, id LIMIT ? OFFSET ?`, rowArgs: [...kinds, limit, offset] };
}
export function indexManifest(value) {
  if (!value || value.format !== 'ubr-anna-sqlite' || value.version !== 1 || value.payload !== 'metadata-only'
      || typeof value.complete !== 'boolean' || !/^\d{8}$/.test(value.snapshot || '') || !/^[a-f\d]{40}$/.test(value.infoHash || '')
      || !Number.isSafeInteger(value.records) || value.records < 1 || !['book', 'comic'].every((kind) => Number.isSafeInteger(value.counts?.[kind]) && value.counts[kind] >= 0)
      || value.counts.book + value.counts.comic !== value.records || !Array.isArray(value.shards)
      || value.searchLayout !== undefined && value.searchLayout !== 'partitioned-fts-v1'
      || new Set(value.shards).size !== value.shards.length || value.shards.some((n) => !Number.isSafeInteger(n) || n < 0 || n > 11)
      || value.complete && value.shards.length !== 12) throw new Error('This file is not a verified registry metadata index.');
  return value;
}
