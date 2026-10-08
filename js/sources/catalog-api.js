import { getSetting } from '../db.js';
export const DEFAULT_CATALOG_URL = 'http://127.0.0.1:8787';
export function validateCatalogUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS service URL without credentials, a query or a fragment.');
  }
  return url.href.replace(/\/$/, '');
}
export async function catalogRequest(path, params = {}, init = {}) {
  const base = validateCatalogUrl(await getSetting('catalogUrl', DEFAULT_CATALOG_URL));
  const url = new URL(`${base}/api/catalog/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  let response;
  try { response = await fetch(url, { ...(init.method !== 'POST' && { signal: AbortSignal.timeout(25000) }), ...init }); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('The catalog service is unavailable. Check its connection in Settings.');
  }
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || `Catalog request failed (HTTP ${response.status}).`);
  return json;
}
