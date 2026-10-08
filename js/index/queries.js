export function searchExpression(query) {
  let text = query.trim().normalize('NFKC');
  if (/^[\dXx\s-]+$/.test(text) && [10, 13].includes(text.replace(/[\s-]/g, '').length)) text = text.replace(/[\s-]/g, '');
  return (text.match(/[\p{L}\p{N}]+/gu) || []).slice(0, 20).map((term) => `"${term}"*`).join(' AND ');
}
export function searchStatements(query = '', { offset = 0, limit = 30, type } = {}) {
  if (typeof query !== 'string' || query.length > 300 || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || type && !['book', 'comic'].includes(type)) throw new Error('Invalid index search.');
  const expression = searchExpression(query), kinds = type ? [type] : [];
  if (query.trim() && !expression) return { empty: true };
  if (expression) {
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
      || new Set(value.shards).size !== value.shards.length || value.shards.some((n) => !Number.isSafeInteger(n) || n < 0 || n > 11)
      || value.complete && value.shards.length !== 12) throw new Error('This file is not a verified registry metadata index.');
  return value;
}
