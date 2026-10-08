// Project Gutenberg catalogue via Gutendex (CORS-enabled). The book files on
// gutenberg.org are NOT CORS-enabled, so books are read via an external link.
import { fetchJson } from '../util.js';

export function searchUrl(text) {
  const p = new URLSearchParams({ copyright: 'false' });
  if (text.trim()) p.set('search', text.trim());
  // The trailing slash matters: the slash-less URL redirects without CORS headers.
  return `https://gutendex.com/books/?${p}`;
}

// "Stoker, Bram" -> "Bram Stoker"
const displayName = (name) => name.split(',').reverse().map((s) => s.trim()).filter(Boolean).join(' ');

export function mapBook(b) {
  const f = b.formats || {};
  return {
    id: b.id,
    title: b.title,
    author: b.authors.map((a) => displayName(a.name)).join(', ') || 'Unknown',
    cover: f['image/jpeg'] || null,
    languages: b.languages,
    readUrl: `https://www.gutenberg.org/ebooks/${b.id}`,
    epubUrl: f['application/epub+zip'] || null,
    textUrl: f['text/plain; charset=utf-8'] || f['text/plain; charset=us-ascii'] || null,
  };
}

export function mapSearch(json) {
  return { total: json.count, next: json.next, items: json.results.map(mapBook) };
}

export async function search(text, nextUrl) {
  return mapSearch(await fetchJson(nextUrl || searchUrl(text)));
}
