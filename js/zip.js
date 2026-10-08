import { unzipSync } from '../vendor/fflate.js';
import { pageNames, mimeOf } from './pages.js';

// Lazy zip access: the central directory is scanned, but only the requested
// entry is ever inflated.
export function listEntries(data) {
  const names = [];
  unzipSync(data, { filter: (f) => { names.push(f.name); return false; } });
  return names;
}

export function readEntry(data, name) {
  const out = unzipSync(data, { filter: (f) => f.name === name });
  return out[name];
}

export function openArchive(data) {
  const pages = pageNames(listEntries(data));
  if (!pages.length) throw new Error('No images found in this archive.');
  return {
    pages,
    blob: (i) => new Blob([readEntry(data, pages[i])], { type: mimeOf(pages[i]) }),
  };
}
