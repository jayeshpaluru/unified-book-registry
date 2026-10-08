import { torrentUrl } from '../js/sources/anna-downloads.js';
import { torrentInfo } from './torrent-metadata.mjs';

export async function fetchAnnaTorrent(path, { fetchImpl = fetch } = {}) {
  const url = torrentUrl(path);
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw new Error(`Official torrent metadata returned HTTP ${response.status}.`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('Torrent metadata exceeds the supported size.');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks), info = torrentInfo(bytes);
  return { bytes, info };
}
export async function submitAnnaTorrent(client, path, expectedHash, options = {}) {
  if (!/^[a-f\d]{40}$/i.test(expectedHash || '')) throw new Error('Inspect this torrent before submitting it.');
  const { bytes, info } = await fetchAnnaTorrent(path, options);
  if (info.hash !== expectedHash.toLowerCase()) throw new Error('The torrent changed. Inspect it again before downloading.');
  if (info.size > 1_000_000_000_000) throw new Error('This torrent exceeds TorBox’s documented maximum size. Use a supported source instead.');
  const id = await client.addTorrent(bytes);
  return { id, hash: info.hash, status: 'submitted' };
}
