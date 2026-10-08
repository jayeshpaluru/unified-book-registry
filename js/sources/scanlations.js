import { catalogRequest } from './catalog-api.js';
export const SCANLATION_PROVIDERS = { mangakatana: 'MangaKatana', mangapill: 'MangaPill', weebcentral: 'Weeb Central' };
function provider(name) { if (!SCANLATION_PROVIDERS[name]) throw new Error('Unknown manga provider.'); return name; }
export const search = (name, q = '', page = 1) => catalogRequest(`${provider(name)}/search`, { q, page });
export const chapters = (name, id, offset = 0) => catalogRequest(`${provider(name)}/series/${encodeURIComponent(id)}/chapters`, { offset });
export async function loadPages(name, id) {
  const result = await catalogRequest(`${provider(name)}/chapter/${encodeURIComponent(id)}/pages`);
  if (!Array.isArray(result.pages) || !result.pages.length || result.pages.length > 2000) throw new Error('The provider returned no usable chapter pages.');
  return result.pages;
}
