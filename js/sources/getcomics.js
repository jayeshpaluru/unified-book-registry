import { catalogRequest, catalogMode } from './catalog-api.js';
import { mapGetComics, metadataJson } from './public-metadata.js';
const API = 'https://getcomics.org/wp-json/wp/v2/posts';
export async function directSearch(q = '', offset = 0, { fetchImpl = fetch } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000 || String(q).length > 300) throw new Error('Invalid comic search.');
  const url = new URL(API);
  url.search = new URLSearchParams({ per_page: 30, offset, _fields: 'id,title,link,content', ...(q && { search: q }) });
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(25000), credentials: 'omit' });
  if (!response.ok) throw new Error(`GetComics returned HTTP ${response.status}.`);
  const posts = await metadataJson(response);
  if (!Array.isArray(posts) || posts.length > 30) throw new Error('GetComics returned an invalid catalog.');
  // News and sponsorship posts without archive choices are not comic entries.
  const items = posts.map(mapGetComics).filter((post) => post.downloads.length);
  const total = Number(response.headers.get('x-wp-total'));
  const knownTotal = Number.isSafeInteger(total) && total >= items.length && response.headers.has('x-wp-total');
  return { items, total: knownTotal ? total : offset + posts.length, totalIsPostCount: true, next: knownTotal
    ? offset + posts.length < total ? offset + posts.length : null : posts.length === 30 ? offset + 30 : null };
}
export async function search(q = '', offset = 0) {
  if (await catalogMode() !== 'static') return catalogRequest('getcomics/search', { q, offset });
  try { return await directSearch(q, offset); }
  catch (error) {
    try { return await catalogRequest('getcomics/search', { q, offset }); }
    catch { throw error; }
  }
}
export const details = (id) => catalogRequest(`getcomics/post/${encodeURIComponent(id)}`, {});
