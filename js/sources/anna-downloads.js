export const ANNA_SOURCE_ORIGIN = 'https://annas-archive.pk';
export function safeTorrentPath(path) {
  return typeof path === 'string' && path.length <= 1024 && path.endsWith('.torrent')
    && !/[\\:\x00-\x1f\x7f?#%]/.test(path)
    && path.split('/').every((part) => part && part !== '.' && part !== '..');
}
export function torrentUrl(path) {
  if (!safeTorrentPath(path)) throw new Error('Invalid Anna torrent reference.');
  return `${ANNA_SOURCE_ORIGIN}/dyn/small_file/torrents/${path.split('/').map(encodeURIComponent).join('/')}`;
}
export function torrentReferences(raw, data) {
  const values = raw.additional?.torrent_paths || raw.torrent_paths || data.torrent_paths || [];
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const path = typeof value === 'string' ? value : value?.torrent_path;
    if (!safeTorrentPath(path)) return [];
    return [{ path, collection: typeof value?.collection === 'string' ? value.collection : '',
      file: typeof value?.file_level1 === 'string' ? value.file_level1 : '',
      packedFile: typeof value?.file_level2 === 'string' ? value.file_level2 : '' }];
  });
}
export function matchingTorboxFiles(entry, downloads) {
  const md5 = /^md5:([a-f\d]{32})$/i.exec(entry.id || '')?.[1].toLowerCase();
  const files = (entry.torrents || []).filter((torrent) => !torrent.packedFile && torrent.file).map((torrent) => torrent.file.replace(/\\/g, '/').toLowerCase());
  return downloads.flatMap((download) => (download.files || []).flatMap((file) => {
    const name = (file.name || '').replace(/\\/g, '/').toLowerCase(), basename = name.split('/').pop();
    const matchesHash = md5 && (basename === md5 || basename.startsWith(`${md5}.`));
    const matchesPath = files.some((target) => name === target || name.endsWith(`/${target}`));
    return matchesHash || matchesPath ? [{ ...file, downloadId: download.id, kind: download.kind, ready: download.ready }] : [];
  }));
}
