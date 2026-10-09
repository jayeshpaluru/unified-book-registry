// Server/Actions only. Never import this module into the published app.
const API = 'https://api.torbox.app/v1/api/';
const KINDS = new Set(['torrents', 'webdl', 'usenet']);

export function createTorboxClient(token, { fetchImpl = fetch } = {}) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('TORBOX_API_KEY is not configured.');
  token = token.trim();
  async function request(path, params = {}, init = {}) {
    const url = new URL(path, API);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000), redirect: 'error' });
    } catch { throw new Error('TorBox could not be reached.'); }
    // Do not echo upstream error text or URLs: requestdl carries the key in its query.
    if (!response.ok) throw new Error(`TorBox returned HTTP ${response.status}.`);
    let json;
    try { json = await response.json(); } catch { throw new Error('TorBox returned invalid JSON.'); }
    if (json.success === false) throw new Error('TorBox rejected the request. Check your account and API key.');
    return json.data;
  }
  return {
    account: () => request('user/me'),
    cached: (hash) => request('torrents/checkcached', { hash, format: 'object', list_files: true }),
    async addTorrent(bytes) {
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 8 * 1024 * 1024) throw new Error('Invalid torrent metadata.');
      const body = new FormData(); body.set('file', new Blob([bytes], { type: 'application/x-bittorrent' }), 'download.torrent');
      body.set('seed', '3'); body.set('allow_zip', 'false'); body.set('as_queued', 'true');
      const result = await request('torrents/createtorrent', {}, { method: 'POST', body });
      const id = result?.torrent_id ?? result?.id;
      if (!Number.isSafeInteger(id) || id < 0) throw new Error('TorBox returned no submission ID. Check its dashboard before trying again.');
      return id;
    },
    async addWebDownload(value) {
      let url;
      try { url = new URL(value); } catch { throw new Error('Invalid web-download URL.'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.hostname === 'api.torbox.app') throw new Error('Invalid web-download URL.');
      const body = new FormData(); body.set('link', url.href); body.set('as_queued', 'false');
      const result = await request('webdl/createwebdownload', {}, { method: 'POST', body });
      const id = result?.webdownload_id ?? result?.web_id ?? result?.id;
      if (!Number.isSafeInteger(id) || id < 0) throw new Error('TorBox returned no submission ID. Check your account before submitting again.');
      return id;
    },
    async list(kind = 'torrents') {
      if (!KINDS.has(kind)) throw new Error('Invalid TorBox collection.');
      const items = [];
      for (let offset = 0; offset < 10000; offset += 1000) {
        const page = await request(`${kind}/mylist`, { offset, limit: 1000 });
        if (!Array.isArray(page)) throw new Error('TorBox returned an invalid file list.');
        items.push(...page.map((entry) => ({ ...entry, kind })));
        if (page.length < 1000) return items;
      }
      throw new Error('TorBox collection exceeds the supported paging limit.');
    },
    async download(kind, id, fileId) {
      if (!KINDS.has(kind) || ![id, fileId].every((v) => Number.isSafeInteger(Number(v)) && Number(v) >= 0)) {
        throw new Error('Invalid TorBox file reference.');
      }
      const link = await request(`${kind}/requestdl`, { token, [kind === 'torrents' ? 'torrent_id' : kind === 'webdl' ? 'web_id' : 'usenet_id']: id,
        file_id: fileId, redirect: false });
      let url;
      try { url = new URL(link); } catch { throw new Error('TorBox returned an invalid download link.'); }
      let decoded;
      try { decoded = decodeURIComponent(url.href); } catch { throw new Error('TorBox returned an invalid download link.'); }
      if (url.protocol !== 'https:' || url.username || url.password || decoded.includes(token) || url.hostname === 'api.torbox.app') {
        throw new Error('TorBox returned an unsafe download link.');
      }
      return url.href;
    },
  };
}

export function metadataFiles(downloads) {
  return downloads.flatMap((download) => (download.files || []).filter((file) =>
    /(?:^|\/)aarecords[^/]*\.json(?:l)?(?:\.gz|\.zst)?$/i.test(file.name || file.path || '')
  ).map((file) => ({ kind: download.kind, id: download.id, fileId: file.id,
    name: file.name || file.path, size: Number(file.size) || 0, ready: Boolean(download.download_finished || download.download_present) })));
}

// Read-only diagnostic. Select the reference in Actions rather than including
// private account IDs or names in public workflow-dispatch inputs.
export async function probeTorboxDownload(client, kind = 'torrents') {
  if (!KINDS.has(kind)) throw new Error('Invalid TorBox collection.');
  const downloads = await client.list(kind);
  const validId = (value) => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) &&
    Number.isSafeInteger(Number(value)) && Number(value) >= 0;
  for (const download of downloads) {
    if (!validId(download.id) || download.download_present === false ||
      !(download.download_present || download.download_finished)) continue;
    for (const file of download.files || []) {
      const fileSize = Number(file.size);
      if (!validId(file.id) || !Number.isSafeInteger(fileSize) || fileSize < 4096) continue;
      return { url: await client.download(kind, download.id, file.id), kind, fileSize };
    }
  }
  throw new Error('No ready TorBox file is available for the read-only range check.');
}

// Count-only discovery: never return account file names, IDs, URLs or upstream
// errors. Optional collections may be unavailable on the account's plan.
export async function inspectMetadataAvailability(client) {
  const collections = await Promise.all([...KINDS].map(async (kind) => {
    try {
      const files = metadataFiles(await client.list(kind));
      return { kind, status: 'checked', ready: files.filter((file) => file.ready).length };
    } catch {
      return { kind, status: 'unavailable', ready: null };
    }
  }));
  return { ready: collections.reduce((total, collection) => total + (collection.ready || 0), 0), collections };
}
