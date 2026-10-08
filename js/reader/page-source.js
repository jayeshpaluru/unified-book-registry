// Page sources: a uniform { count, getUrl(i), release(url) } over CBZ, PDF,
// Internet Archive and OPDS-PSE pages.
import { openArchive } from '../zip.js';
import { loadPdfjs } from '../lib.js';
import { loadPages } from '../sources/archive.js';
import { loadPages as mangaDexPages } from '../sources/mangadex.js';
import { loadPages as scanlationPages } from '../sources/scanlations.js';
import { pseUrl, authHeaders } from '../sources/opds.js';
import * as db from '../db.js';

const MAX_CANVAS_PIXELS = 16_000_000;

async function fileBlob(item) {
  const blob = await db.getBlob(item.id);
  if (!blob) throw new Error('The stored file is missing. Delete this entry and import it again.');
  return blob;
}

async function cbzSource(item) {
  const archive = openArchive(new Uint8Array(await (await fileBlob(item)).arrayBuffer()));
  return {
    count: archive.pages.length,
    getUrl: async (i) => URL.createObjectURL(archive.blob(i)),
    release: (url) => URL.revokeObjectURL(url),
  };
}

async function pdfSource(item) {
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument({ data: await (await fileBlob(item)).arrayBuffer() }).promise;
  return {
    count: pdf.numPages,
    async getUrl(i) {
      const page = await pdf.getPage(i + 1);
      const base = page.getViewport({ scale: 1 });
      const dpr = window.devicePixelRatio || 1;
      let scale = dpr * Math.max(innerWidth / base.width, innerHeight / base.height);
      scale = Math.min(scale, Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      return URL.createObjectURL(blob);
    },
    release: (url) => URL.revokeObjectURL(url),
  };
}

async function iaSource(item) {
  const { pages } = await loadPages(item.iaId);
  return { count: pages.length, getUrl: async (i) => pages[i], release() {} };
}

async function pseSource(item) {
  const source = await db.get('sources', item.sourceId);
  const headers = authHeaders(source);
  const { template, count } = item.pse;
  const authed = Object.keys(headers).length > 0;
  return {
    count,
    async getUrl(i) {
      const url = pseUrl(template, i);
      if (!authed) return url;
      // <img> cannot send an Authorization header, so fetch the page ourselves.
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`Page ${i + 1} failed (HTTP ${res.status})`);
      return URL.createObjectURL(await res.blob());
    },
    release: (url) => url.startsWith('blob:') && URL.revokeObjectURL(url),
  };
}

async function mangaDexSource(item) {
  const pages = await mangaDexPages(item.chapterId);
  return { count: pages.length, getUrl: async (i) => pages[i], release() {} };
}

async function scanlationSource(item) {
  let pages = await scanlationPages(item.provider, item.chapterId);
  return { count: pages.length, getUrl: async (i) => pages[i], release() {}, async refresh() {
    const next = await scanlationPages(item.provider, item.chapterId);
    if (next.length !== pages.length) throw new Error('The chapter page count changed. Close and reopen this chapter.');
    pages = next;
  } };
}

const FACTORIES = { cbz: cbzSource, pdf: pdfSource, ia: iaSource, pse: pseSource, mangadex: mangaDexSource, scanlation: scanlationSource };

export const openPageSource = (item) => FACTORIES[item.format](item);
