import { createCatalogApi } from '../server/catalog.mjs';
import { openAnnaStore } from '../server/anna-store.mjs';
import { createTorboxClient, probeTorboxDownload } from '../server/torbox.mjs';
import { sealResult } from '../server/sealed-result.mjs';
import { fetchAnnaTorrent, submitAnnaTorrent } from '../server/anna-downloads.mjs';
import { resolveGetComicsDownload } from '../server/public-readers.mjs';

const requestId = process.env.REQUEST_ID || '';
const publicKey = process.env.SESSION_PUBLIC_KEY || '';
const repo = process.env.GITHUB_REPOSITORY || '';
if (!/^\d{13}-[a-f0-9-]{36}$/.test(requestId) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid runtime request.');
// Validate encryption before making any private API request.
sealResult({ validation: true }, publicKey);

async function github(path, method = 'GET', body) {
  const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
    method, headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Runtime result storage returned HTTP ${response.status}.`);
  return response.status === 204 ? null : response.json();
}

async function execute() {
  const path = process.env.REQUEST_PATH || '';
  let params;
  try { params = JSON.parse(process.env.REQUEST_PARAMS || '{}'); } catch { throw new Error('Invalid request parameters.'); }
  if (!params || Array.isArray(params) || typeof params !== 'object') throw new Error('Invalid request parameters.');
  if (path === 'anna/torrent-info') {
    const { info } = await fetchAnnaTorrent(params.torrentPath);
    return { hash: info.hash, size: info.size, files: info.files.length };
  }
  if (path.startsWith('torbox/')) {
    const client = createTorboxClient(process.env.TORBOX_API_KEY);
    if (path === 'torbox/list') {
      const downloads = await client.list(params.kind || 'torrents');
      return { items: downloads.map((entry) => ({ id: entry.id, kind: entry.kind, name: entry.name,
        ready: Boolean(entry.download_finished || entry.download_present),
        files: (entry.files || []).map((file) => ({ id: file.id, name: file.name || file.path, size: Number(file.size) || 0 })) })) };
    }
    if (path === 'torbox/download') return { url: await client.download(params.kind || 'torrents', params.id, params.fileId) };
    if (path === 'torbox/link-probe') return probeTorboxDownload(client, params.kind || 'torrents');
    if (path === 'torbox/add-anna') return submitAnnaTorrent(client, params.torrentPath, params.expectedHash);
    if (path === 'torbox/add-getcomics') {
      const file = await resolveGetComicsDownload(params.postId, Number(params.index), { selectedUrl: params.selectedUrl });
      return { id: await client.addWebDownload(file.url), kind: 'webdl' };
    }
    throw new Error('Unsupported TorBox operation.');
  }
  if (!/^(?:mangadex\/(?:search|manga\/[a-f\d-]+\/chapters|chapter\/[a-f\d-]+\/pages)|mangaupdates\/(?:search|series\/\d+\/releases)|getcomics\/(?:search|resolve|post\/\d+)|(?:mangapill|weebcentral)\/(?:search|series\/[0-9A-Z]+\/chapters|chapter\/[0-9A-Z-]+\/pages)|mangakatana\/(?:search|series\/[a-z\d.-]+\/chapters|chapter\/[a-z\d.~:-]+\/pages))$/.test(path)) {
    throw new Error('Unsupported live catalog operation.');
  }
  const store = openAnnaStore();
  try { return await createCatalogApi(store)(path, new URLSearchParams(params)); } finally { store.close(); }
}

let result;
try { result = { data: await execute() }; }
catch (error) {
  const message = String(error.message || 'The request failed.');
  result = { error: process.env.TORBOX_API_KEY && message.includes(process.env.TORBOX_API_KEY) ? 'The private request failed.' : message.slice(0, 500) };
}
const sealed = sealResult({ ...result, requestId, expiresAt: Date.now() + 45 * 60 * 1000 }, publicKey);
let branch = await github('git/ref/heads/runtime-results');
if (!branch) {
  const main = await github('git/ref/heads/main');
  branch = await github('git/refs', 'POST', { ref: 'refs/heads/runtime-results', sha: main.object.sha });
}
await github(`contents/requests/${requestId}.json`, 'PUT', { message: 'Store encrypted runtime response', branch: 'runtime-results',
  content: Buffer.from(JSON.stringify(sealed)).toString('base64') });
// Bounded retention. Only delete generated ciphertext older than a day or beyond 50 responses.
const files = await github('contents/requests?ref=runtime-results');
const names = files.filter((file) => /^\d{13}-[a-f0-9-]{36}\.json$/.test(file.name)).sort((a, b) => b.name.localeCompare(a.name));
for (const [index, file] of names.entries()) {
  if (index < 50 && Number(file.name.slice(0, 13)) >= Date.now() - 86400000) continue;
  await github(`contents/requests/${file.name}`, 'DELETE', { message: 'Expire generated encrypted response', branch: 'runtime-results', sha: file.sha });
}
console.log('Encrypted runtime response stored. No private data or download links were logged.');
