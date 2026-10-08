// Lazy loaders for the heavy vendored libraries.
import { loadScript } from './util.js';

const vendor = (f) => new URL(`../vendor/${f}`, import.meta.url).href;

export async function loadPdfjs() {
  await loadScript(vendor('pdf.min.js'));
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = vendor('pdf.worker.min.js');
  return window.pdfjsLib;
}

export async function loadEpubjs() {
  await loadScript(vendor('jszip.min.js'));
  await loadScript(vendor('epub.min.js'));
  return window.ePub;
}
