// Turns user files into library items stored in IndexedDB.
import { zipSync } from '../vendor/fflate.js';
import { naturalCompare } from './util.js';
import { isImageName } from './pages.js';
import { openArchive } from './zip.js';
import { loadPdfjs, loadEpubjs } from './lib.js';
import { putItem, putBlob } from './db.js';

const COVER_WIDTH = 360;
const UNSUPPORTED = /\.(cbr|rar|cb7|7z|cbt)$/i;
const ext = (name) => name.split('.').pop().toLowerCase();

async function toCover(source) {
  const bitmap = await createImageBitmap(source);
  const scale = Math.min(1, COVER_WIDTH / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
}

async function pdfInfo(buffer) {
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument({ data: buffer.slice(0) }).promise;
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: COVER_WIDTH / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  const cover = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
  const total = pdf.numPages;
  pdf.destroy();
  return { total, cover };
}

async function epubInfo(buffer) {
  const ePub = await loadEpubjs();
  const book = ePub(buffer.slice(0));
  try {
    const meta = await book.loaded.metadata;
    const url = await book.coverUrl();
    const cover = url ? await toCover(await (await fetch(url)).blob()) : null;
    return { title: meta.title, cover };
  } finally {
    book.destroy();
  }
}

function base(file, type, format) {
  return {
    id: crypto.randomUUID(),
    type,
    format,
    title: file.name.replace(/\.[^.]+$/, ''),
    addedAt: Date.now(),
    lastRead: 0,
    read: false,
    progress: { pct: 0, page: 0 },
    mode: type === 'manga' ? 'rtl' : undefined,
  };
}

async function save(item, blob) {
  await putBlob(item.id, blob);
  await putItem(item);
  return item;
}

// type: 'auto' | 'comic' | 'manga' | 'book'
async function importOne(file, type) {
  if (UNSUPPORTED.test(file.name)) {
    throw new Error(`${file.name}: CBR/RAR archives are not supported. Convert it to CBZ first (e.g. with Calibre or Komga).`);
  }
  const kind = ext(file.name);
  const pick = (fallback) => (type === 'auto' ? fallback : type);

  if (kind === 'cbz' || kind === 'zip') {
    const { pages, blob } = openArchive(new Uint8Array(await file.arrayBuffer()));
    const item = { ...base(file, pick('comic'), 'cbz'), progress: { pct: 0, page: 0, total: pages.length } };
    item.cover = await toCover(blob(0)).catch(() => null);
    return save(item, file);
  }
  if (kind === 'pdf') {
    const { total, cover } = await pdfInfo(await file.arrayBuffer());
    return save({ ...base(file, pick('comic'), 'pdf'), cover, progress: { pct: 0, page: 0, total } }, file);
  }
  if (kind === 'epub') {
    const { title, cover } = await epubInfo(await file.arrayBuffer());
    const item = { ...base(file, pick('book'), 'epub'), cover };
    if (title) item.title = title;
    return save(item, file);
  }
  if (['txt', 'html', 'htm', 'xhtml'].includes(kind)) {
    return save({ ...base(file, pick('book'), kind === 'txt' ? 'text' : 'html') }, file);
  }
  throw new Error(`${file.name}: unsupported file type. Use CBZ, ZIP, EPUB, PDF, TXT/HTML or images.`);
}

async function importImages(files, type) {
  const sorted = [...files].sort((a, b) => naturalCompare(a.name, b.name));
  const entries = {};
  for (const f of sorted) entries[f.name] = [new Uint8Array(await f.arrayBuffer()), { level: 0 }];
  const zipped = new Blob([zipSync(entries)], { type: 'application/zip' });
  const folder = sorted[0].webkitRelativePath?.split('/')[0];
  const name = `${folder || sorted[0].name.replace(/\.[^.]+$/, '')}.cbz`;
  return importOne(new File([zipped], name), type === 'auto' ? 'comic' : type);
}

// Returns { added: Item[], errors: string[] }. Loose images become one CBZ.
export async function importFiles(fileList, type = 'auto') {
  const files = [...fileList].filter((f) => !f.name.startsWith('.'));
  const images = files.filter((f) => isImageName(f.name));
  const others = files.filter((f) => !isImageName(f.name));
  const added = [];
  const errors = [];
  const jobs = others.map((f) => () => importOne(f, type));
  if (images.length) jobs.push(() => importImages(images, type));
  for (const job of jobs) {
    try {
      added.push(await job());
    } catch (e) {
      errors.push(e.message);
    }
  }
  return { added, errors };
}

// Flattens dropped folders into files (DataTransfer entries API).
export async function filesFromDrop(dataTransfer) {
  const walk = async (entry, prefix = '') => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      return [Object.defineProperty(file, 'webkitRelativePath', { value: prefix + file.name })];
    }
    const reader = entry.createReader();
    const children = [];
    for (let batch; (batch = await new Promise((res, rej) => reader.readEntries(res, rej))).length;) children.push(...batch);
    return (await Promise.all(children.map((c) => walk(c, `${prefix}${entry.name}/`)))).flat();
  };
  const entries = [...dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files];
  return (await Promise.all(entries.map((e) => walk(e)))).flat();
}
