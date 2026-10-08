import { createHash } from 'node:crypto';

// Parse public torrent metadata, preserving the exact bencoded info bytes for its hash.
export function torrentInfo(bytes) {
  bytes = Buffer.from(bytes); let cursor = 0, infoStart, infoEnd;
  function parse(top = false) {
    const marker = String.fromCharCode(bytes[cursor]);
    if (marker === 'i') { const end = bytes.indexOf(101, ++cursor); if (end < 0) throw new Error('Invalid torrent metadata.');
      const value = Number(bytes.subarray(cursor, end).toString()); cursor = end + 1; return value; }
    if (marker === 'l') { cursor++; const value = []; while (bytes[cursor] !== 101) value.push(parse()); cursor++; return value; }
    if (marker === 'd') {
      cursor++; const value = {};
      while (bytes[cursor] !== 101) {
        const key = parse().toString(); const start = cursor; value[key] = parse();
        if (top && key === 'info') { infoStart = start; infoEnd = cursor; }
      }
      cursor++; return value;
    }
    const colon = bytes.indexOf(58, cursor); const length = Number(bytes.subarray(cursor, colon).toString());
    if (colon < cursor || !Number.isSafeInteger(length) || length < 0 || colon + 1 + length > bytes.length) throw new Error('Invalid torrent metadata.');
    cursor = colon + 1 + length; return bytes.subarray(colon + 1, cursor);
  }
  const torrent = parse(true);
  if (infoStart === undefined || !torrent.info) throw new Error('Torrent has no info dictionary.');
  const files = (torrent.info.files || [{ length: torrent.info.length, path: [torrent.info.name] }]).map((file) =>
    ({ name: file.path.map((part) => part.toString()).join('/'), size: file.length }));
  return { hash: createHash('sha1').update(bytes.subarray(infoStart, infoEnd)).digest('hex'), files,
    size: files.reduce((sum, file) => sum + file.size, 0) };
}
