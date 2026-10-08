import { cp, mkdir, readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function buildSite({ root = fileURLToPath(new URL('../', import.meta.url)), output = resolve('dist'), catalog = resolve('build/catalog') } = {}) {
  await mkdir(output, { recursive: true });
  const allowed = ['index.html', '.nojekyll', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons', 'vendor', 'catalog'];
  const unexpected = (await readdir(output)).filter((name) => !allowed.includes(name));
  if (unexpected.length) throw new Error('Build output contains unexpected files. Use a new output directory; nothing was deleted.');
  // Explicit allowlist: no .git, workflows, server, data, env files, logs or credentials.
  for (const name of allowed.filter((name) => name !== 'catalog')) {
    await cp(join(root, name), join(output, name), { recursive: true });
  }
  await cp(catalog, join(output, 'catalog'), { recursive: true });
  const worker = await readFile(join(output, 'sw.js'), 'utf8');
  const version = (process.env.GITHUB_SHA || String(Date.now())).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  await writeFile(join(output, 'sw.js'), worker.replace("const VERSION = 'v3';", `const VERSION = 'v3-${version}';`));
  async function size(path) {
    const info = await stat(path);
    if (!info.isDirectory()) return info.size;
    return (await Promise.all((await readdir(path)).map((name) => size(join(path, name))))).reduce((a, b) => a + b, 0);
  }
  const bytes = await size(output);
  if (bytes > 900 * 1024 * 1024) throw new Error('Published site exceeds the safe Pages budget. The complete metadata index needs separate storage.');
  console.log(`Static site built: ${(bytes / 1024 / 1024).toFixed(1)} MB. No server or secrets included.`);
  return { output, bytes };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildSite().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
