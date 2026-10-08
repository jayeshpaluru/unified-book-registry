// Read immutable metadata snapshots without downloading the complete database.
// File URLs, fetched pages and caches stay only in this tab/worker's memory.
export class RangeReader {
  constructor(url, { fetchImpl = fetch, expectedSize = 0, blockSize = 65536, cacheBytes = 16 * 1024 * 1024 } = {}) {
    const parsed = new URL(url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.username || parsed.password || !(parsed.protocol === 'https:' || local && parsed.protocol === 'http:')) throw new Error('Use a secure metadata file URL.');
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > 1e12) throw new Error('Invalid index size.');
    if (!Number.isSafeInteger(blockSize) || blockSize < 1024 || blockSize > 1024 * 1024 || blockSize & (blockSize - 1)
        || !Number.isSafeInteger(cacheBytes) || cacheBytes < blockSize || cacheBytes > 64 * 1024 * 1024) throw new Error('Invalid range cache size.');
    this.url = parsed.href; this.fetchImpl = fetchImpl.bind(globalThis); this.size = expectedSize;
    this.blockSize = blockSize; this.maxBlocks = Math.max(1, Math.floor(cacheBytes / blockSize));
    this.cache = new Map(); this.etag = null; this.totalBytes = 0; this.totalRequests = 0;
    this.beginQuery();
  }
  beginQuery({ maxRequests = 256, maxBytes = 16 * 1024 * 1024, timeoutMs = 30000 } = {}) {
    this.budget = { requests: 0, bytes: 0, maxRequests, maxBytes, deadline: Date.now() + timeoutMs };
    this.error = ''; this.cancelled = false;
  }
  async block(index) {
    if (this.cancelled || Date.now() >= this.budget.deadline) throw new Error('Index query timed out. Try a more specific title, author or ISBN.');
    if (this.cache.has(index)) {
      const bytes = this.cache.get(index); this.cache.delete(index); this.cache.set(index, bytes); return bytes;
    }
    if (++this.budget.requests > this.budget.maxRequests) throw new Error('Index query exceeded its range budget. Use a more specific search.');
    const start = index * this.blockSize;
    const end = this.size ? Math.min(this.size - 1, start + this.blockSize - 1) : start + this.blockSize - 1;
    let response;
    try {
      response = await this.fetchImpl(this.url, { headers: { Range: `bytes=${start}-${end}` }, credentials: 'omit',
        referrerPolicy: 'no-referrer', cache: 'no-store', signal: AbortSignal.timeout(Math.max(1, this.budget.deadline - Date.now())) });
    } catch { throw new Error('The index server blocked browser range access or the request timed out.'); }
    const cancel = () => response.body?.cancel().catch(() => {});
    if ([401, 403, 410].includes(response.status)) { await cancel(); throw new Error('The index link expired or access was denied. Generate a fresh TorBox link.'); }
    if (response.status !== 206) { await cancel(); throw new Error('The index server must support HTTP byte ranges (206). No full database download was accepted.'); }
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
    const [first, last, size] = range ? range.slice(1).map(Number) : [];
    if (!range || ![first, last, size].every(Number.isSafeInteger) || first !== start || last !== Math.min(end, size - 1)
        || size < 100 || size > 1e12 || this.size && this.size !== size) {
      await cancel(); throw new Error('Invalid or browser-hidden Content-Range. The server must expose this header through CORS.');
    }
    const etag = response.headers.get('etag');
    if (this.etag && etag && this.etag !== etag) { await cancel(); throw new Error('The index changed during this session. Reconnect to its immutable snapshot.'); }
    this.etag ||= etag; this.size = size;
    const length = last - first + 1, bytes = new Uint8Array(length); let offset = 0;
    if (!response.body) throw new Error('The index range response was empty.');
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        if (offset + value.length > length) throw new Error('The index server returned more bytes than requested.');
        bytes.set(value, offset); offset += value.length;
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (offset !== length) throw new Error('The index server returned an incomplete byte range.');
    this.budget.bytes += length; this.totalBytes += length; this.totalRequests++;
    if (this.budget.bytes > this.budget.maxBytes) throw new Error('Index query exceeded its download budget. Use a more specific search.');
    this.cache.set(index, bytes);
    if (this.cache.size > this.maxBlocks) this.cache.delete(this.cache.keys().next().value);
    return bytes;
  }
  async read(offset, length) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024) throw new Error('Invalid index read.');
    if (!this.size) await this.block(0);
    const count = Math.max(0, Math.min(length, this.size - offset));
    const output = new Uint8Array(count); let written = 0;
    while (written < count) {
      const position = offset + written, index = Math.floor(position / this.blockSize);
      const block = await this.block(index), start = position % this.blockSize;
      const n = Math.min(block.length - start, count - written);
      if (n <= 0) throw new Error('Invalid index range boundary.');
      output.set(block.subarray(start, start + n), written); written += n;
    }
    return output;
  }
  stats() { return { bytes: this.totalBytes, requests: this.totalRequests, cachedBytes: [...this.cache.values()].reduce((n, b) => n + b.length, 0), size: this.size }; }
  close() { this.cancelled = true; this.cache.clear(); this.url = ''; }
}
