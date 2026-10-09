// This self-contained function also runs in an isolated browser at the actual
// Pages origin. Never return or log the private URL, file contents or names.
export async function probeTorboxRange(url, expectedSize, { fetchImpl = fetch } = {}) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 4096) throw new Error('Invalid range-check file size.');
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', headers: { Range: 'bytes=0-4095' }, mode: 'cors',
      credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000) });
  } catch { throw new Error('The temporary TorBox link could not be fetched from the Pages origin.'); }
  const rejectResponse = async (message) => {
    await response.body?.cancel().catch(() => {});
    throw new Error(message);
  };
  if (response.status !== 206) return rejectResponse(`The TorBox file host returned HTTP ${response.status}, not a byte range. Its body was cancelled.`);
  const range = /^bytes 0-4095\/(\d+)$/.exec(response.headers.get('content-range') || '');
  if (!range || Number(range[1]) !== expectedSize) return rejectResponse('TorBox did not expose the expected Content-Range to the Pages origin.');
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding !== 'identity') return rejectResponse('TorBox served a compressed range, unsuitable for the SQLite index.');
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) !== 4096) return rejectResponse('TorBox returned an unexpected byte-range length.');
  if (!response.body) throw new Error('TorBox returned no byte-range body.');
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) throw new Error('TorBox exceeded the 4 KiB diagnostic body limit.');
    }
    if (bytes !== 4096) throw new Error('TorBox returned an incomplete byte range.');
    return { status: response.status, bytes, rangeExposed: true, totalMatched: true };
  } catch (error) {
    if (error.message?.startsWith('TorBox ')) throw error;
    throw new Error('The TorBox byte-range body could not be read.');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
