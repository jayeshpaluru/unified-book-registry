import { h } from './dom.js';
export function sourceLink(label, href, className = 'btn', filename) {
  try { if (!['http:', 'https:'].includes(new URL(href).protocol)) return null; } catch { return null; }
  return h('a', { class: className, href, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer', download: filename || undefined }, label);
}
