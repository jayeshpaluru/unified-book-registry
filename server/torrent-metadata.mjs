import { createHash } from 'node:crypto';

// Parse public torrent metadata, preserving the exact bencoded info bytes for its hash.
export function torrentInfo(bytes) {
  bytes = Buffer.from(bytes); let cursor = 0, infoStart, infoEnd;
  function parse(top = false) {
    if (cursor >= bytes.length) throw new Error('Truncated torrent metadata.');
    const marker = String.fromCharCode(bytes[cursor]);
    if (marker === 'i') { const end = bytes.indexOf(101, ++cursor); if (end < 0) throw new Error('Invalid torrent metadata.');
      const text = bytes.subarray(cursor, end).toString();
      const value = Number(text);
      if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(value)) throw new Error('Invalid torrent integer.');
      cursor = end + 1; return value; }
    if (marker === 'l') { cursor++; const value = []; while (bytes[cursor] !== 101) value.push(parse()); cursor++; return value; }
    if (marker === 'd') {
      cursor++; const value = Object.create(null);
      while (bytes[cursor] !== 101) {
        const key = parse().toString(); const start = cursor; value[key] = parse();
        if (top && key === 'info') { infoStart = start; infoEnd = cursor; }
      }
      cursor++; return value;
    }
    const colon = bytes.indexOf(58, cursor); const text = bytes.subarray(cursor, colon).toString(); const length = Number(text);
    if (colon < cursor || !/^\d+$/.test(text) || !Number.isSafeInteger(length) || length < 0 || colon + 1 + length > bytes.length) throw new Error('Invalid torrent metadata.');
    cursor = colon + 1 + length; return bytes.subarray(colon + 1, cursor);
  }
  const torrent = parse(true);
  if (infoStart === undefined || !torrent.info || cursor !== bytes.length) throw new Error('Torrent has no valid info dictionary.');
  const files = (torrent.info.files || [{ length: torrent.info.length, path: [torrent.info.name] }]).map((file) =>
    ({ name: file.path.map((part) => part.toString()).join('/'), size: file.length }));
  if (files.some((file) => !Number.isSafeInteger(file.size) || file.size < 0)) throw new Error('Invalid torrent file size.');
  return { hash: createHash('sha1').update(bytes.subarray(infoStart, infoEnd)).digest('hex'), files,
    name: torrent.info.name.toString(), pieceLength: torrent.info['piece length'],
    size: files.reduce((sum, file) => sum + file.size, 0) };
}
