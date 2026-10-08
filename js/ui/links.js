import { h } from './dom.js';
import { saveRemoteFile } from '../downloads.js';
export function sourceLink(label, href, className = 'btn', filename) {
  let url;
  try {
    url = new URL(href);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  } catch { return null; }
  // Credits are text, never a route out of the reader. Remote files are fetched
  // and saved as same-origin blobs; cross-origin `download` anchors can navigate.
  if (!filename) return h('span', { class: className === 'credit-link' ? 'credit-link' : 'muted' }, label.replace(/\s*↗$/, ''));
  const status = h('span', { class: 'muted', role: 'status' });
  let controller;
  const cancel = h('button', { class: 'btn', hidden: true, onClick: () => controller?.abort() }, 'Cancel download');
  const button = h('button', { class: className, onClick: async () => {
    button.disabled = true; controller = new AbortController(); cancel.hidden = false; status.textContent = 'Choose a destination or wait for the download…';
    try {
      await saveRemoteFile(url.href, filename, { signal: controller.signal, onProgress: (size) => { status.textContent = `${(size / 1e6).toFixed(1)} MB downloaded…`; } });
      status.textContent = 'File saved to your device.';
    } catch (error) { status.textContent = error.name === 'AbortError' || controller.signal.aborted ? 'Download cancelled.'
      : error instanceof TypeError ? 'The file host does not allow an in-app browser download.' : error.message; }
    finally { button.disabled = false; cancel.hidden = true; }
  } }, label.replace(/\s*↗$/, ''));
  return h('span', { class: 'download-control' }, button, cancel, status);
}
