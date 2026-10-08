import { cp } from 'node:fs/promises';
// Materialize the already validated public catalog build as a fallback snapshot.
// No account responses, credentials, TorBox file lists or private temporary links are included.
await cp('build/catalog', 'catalog', { recursive: true });
console.log('Saved public metadata fallback snapshot.');
