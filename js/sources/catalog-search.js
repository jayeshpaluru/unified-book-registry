export function normalizeText(value = '') {
  return String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}
export function searchRecords(records, query = '', { offset = 0, limit = 30, type } = {}) {
  const terms = normalizeText(query).match(/[\p{L}\p{N}]+/gu) || [];
  const isbn = /^[\dXx\s-]+$/.test(query) && [10, 13].includes(query.replace(/[\s-]/g, '').length)
    ? query.replace(/[\s-]/g, '').toLowerCase() : null;
  const matched = records.filter((record) => {
    const entry = record.entry || record;
    if (type && entry.type !== type) return false;
    if (query.trim() && !terms.length) return false;
    const text = normalizeText([entry.title, entry.author, ...(entry.isbn || [])].join(' '));
    return isbn ? (entry.isbn || []).some((value) => value.replace(/[\s-]/g, '').toLowerCase() === isbn)
      : terms.every((term) => text.includes(term));
  });
  return { items: matched.slice(offset, offset + limit), total: matched.length,
    next: offset + limit < matched.length ? offset + limit : null };
}
