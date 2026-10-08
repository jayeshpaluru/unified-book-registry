// OPDS 1.x (Atom) parsing plus authenticated fetching.
import { basicAuthHeader } from '../util.js';

const REL_ACQ = 'http://opds-spec.org/acquisition';
const REL_THUMB = 'http://opds-spec.org/image/thumbnail';
const REL_IMAGE = 'http://opds-spec.org/image';
const REL_PSE = 'http://vaemendis.net/opds-pse/stream';

const local = (el) => el.localName || el.tagName.split(':').pop();
const kids = (el, name) => [...el.children].filter((c) => local(c) === name);
const text = (el, name) => kids(el, name)[0]?.textContent.trim() || '';

export function formatOfType(type = '') {
  if (/epub/i.test(type)) return 'epub';
  if (/pdf/i.test(type)) return 'pdf';
  if (/zip|cbz/i.test(type)) return 'cbz';
  return null;
}

function resolve(href, base) {
  return new URL(href, base).href;
}

function parseEntry(entry, base) {
  const links = kids(entry, 'link').map((l) => ({
    rel: l.getAttribute('rel') || '',
    type: l.getAttribute('type') || '',
    href: l.getAttribute('href'),
    count: Number(l.getAttribute('pse:count')) || 0,
  })).filter((l) => l.href);

  const acquisitions = links
    .filter((l) => l.rel.startsWith(REL_ACQ))
    .map((l) => ({ href: resolve(l.href, base), type: l.type, format: formatOfType(l.type) }));
  const pseLink = links.find((l) => l.rel === REL_PSE);
  const nav = links.find((l) => !l.rel.startsWith(REL_ACQ) && l.rel !== REL_PSE && /atom\+xml/i.test(l.type));
  const thumb = links.find((l) => l.rel === REL_THUMB) || links.find((l) => l.rel === REL_IMAGE);

  return {
    id: text(entry, 'id'),
    title: text(entry, 'title'),
    author: kids(entry, 'author').map((a) => text(a, 'name')).join(', '),
    summary: text(entry, 'summary') || text(entry, 'content'),
    thumb: thumb ? resolve(thumb.href, base) : null,
    nav: nav ? resolve(nav.href, base) : null,
    acquisitions,
    // Page URL template still contains the literal {pageNumber} placeholder.
    pse: pseLink
      ? { template: resolve(pseLink.href, base).replace(/%7B/gi, '{').replace(/%7D/gi, '}'), count: pseLink.count }
      : null,
  };
}

// Takes an already-parsed XML document so it can be tested without DOMParser.
export function parseFeed(doc, base) {
  const feed = doc.documentElement;
  const next = kids(feed, 'link').find((l) => l.getAttribute('rel') === 'next');
  return {
    title: text(feed, 'title'),
    next: next ? resolve(next.getAttribute('href'), base) : null,
    entries: kids(feed, 'entry').map((e) => parseEntry(e, base)),
  };
}

// OPDS-PSE page numbers are zero-based.
export const pseUrl = (template, index) => template.replace('{pageNumber}', index).replace('{maxWidth}', 1600);

export function authHeaders(source) {
  return basicAuthHeader(source?.user, source?.pass);
}

export async function fetchFeed(url, source) {
  const res = await fetch(url, { headers: authHeaders(source) });
  if (!res.ok) throw new Error(`Server replied HTTP ${res.status}`);
  const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('The server did not return a valid OPDS feed.');
  return parseFeed(doc, res.url || url);
}

export async function download(url, source) {
  const res = await fetch(url, { headers: authHeaders(source) });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  return res.blob();
}
