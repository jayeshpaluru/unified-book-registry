import { naturalCompare } from './util.js';

const IMAGE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' };

export const isImageName = (name) => IMAGE.test(name);

export function mimeOf(name) {
  return MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream';
}

// Filters archive entry names down to readable pages, in natural reading order.
export function pageNames(names) {
  return names
    .filter((n) => {
      if (n.endsWith('/') || !IMAGE.test(n)) return false;
      return !n.split('/').some((part) => part === '__MACOSX' || part.startsWith('.'));
    })
    .sort(naturalCompare);
}
