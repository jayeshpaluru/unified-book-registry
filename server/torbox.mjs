// Server/Actions only. Never import this module into the published app.
const API = 'https://api.torbox.app/v1/api/';
const KINDS = new Set(['torrents', 'webdl', 'usenet']);

export function createTorboxClient(token, { fetchImpl = fetch } = {}) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('TORBOX_API_KEY is not configured.');
  token = token.trim();
  async function request(path, params = {}) {
    const url = new URL(path, API);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
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
