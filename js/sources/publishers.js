import { catalogRequest } from './catalog-api.js';
export const search = (provider, text, offset = 0) => catalogRequest(`${provider}/search`, { q: text, offset });
