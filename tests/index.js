// Entry point so that `node --test tests/` works: Node 24 treats a directory
// argument as a module path, so this loads every *.test.mjs file next to it.
import { readdirSync } from 'node:fs';

for (const file of readdirSync(new URL('.', import.meta.url)).filter((f) => f.endsWith('.test.mjs')).sort()) {
  await import(`./${file}`);
}
