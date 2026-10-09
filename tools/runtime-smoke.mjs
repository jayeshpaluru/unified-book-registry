// End-to-end check through your authenticated gh CLI; never prints private file names or URLs.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { webcrypto } from 'node:crypto';
import { openSealedResult, to64 } from '../js/sources/github-jobs.js';
import { mapPages as mangaDexPages } from '../js/sources/mangadex.js';
import { KATANA_CHAPTER_ID } from '../server/mangakatana.mjs';
import { mapGetComics, metadataJson, httpsUrl } from '../js/sources/public-metadata.js';
import { probeTorboxRange } from './torbox-range-probe.mjs';
const exec = promisify(execFile);
const repo = 'jayeshpaluru/unified-book-registry';
const publicOnly = process.argv.includes('--public');
const downloadLink = process.argv.includes('--download-link');
const t3 = process.argv.includes('--t3');
const kindPosition = process.argv.indexOf('--kind');
const kind = kindPosition >= 0 ? process.argv[kindPosition + 1] : 'torrents';
if ((downloadLink || kindPosition >= 0) && (publicOnly || !['torrents', 'webdl', 'usenet'].includes(kind))) {
  throw new Error('Private download-link checks require a supported --kind and cannot use --public.');
}
if (t3 && (!downloadLink || publicOnly || kindPosition >= 0)) throw new Error('T3 checks require --download-link --t3 without --public or --kind.');
const providerPosition = process.argv.indexOf('--provider');
const provider = providerPosition >= 0 ? process.argv[providerPosition + 1] : 'mangadex';
const render = process.argv.includes('--render');
if (!['mangadex', 'mangapill', 'weebcentral', 'mangakatana', 'getcomics'].includes(provider) || (providerPosition >= 0 && !publicOnly)) {
  throw new Error('Provider checks require --public and a supported manga provider.');
}
const chapterPosition = process.argv.indexOf('--chapter');
const chapterId = chapterPosition >= 0 ? process.argv[chapterPosition + 1] : null;
const validChapter = provider === 'mangakatana' ? KATANA_CHAPTER_ID.test(chapterId) : provider === 'mangapill'
  ? /^\d{1,9}-\d{1,15}$/.test(chapterId) : provider === 'weebcentral' ? /^[0-9A-HJKMNP-TV-Z]{26}$/.test(chapterId) : /^[a-f\d]{8}-[a-f\d-]{27}$/.test(chapterId);
if (chapterPosition >= 0 && (!publicOnly || provider === 'getcomics' || !validChapter)) throw new Error('Chapter checks require --public and a valid provider chapter reference.');
if (render && (!publicOnly || !chapterId)) throw new Error('Rendering requires --public and --chapter.');
const comicPosition = process.argv.indexOf('--comic'), comicId = comicPosition >= 0 ? process.argv[comicPosition + 1] : null;
const filePosition = process.argv.indexOf('--file-index'), fileIndex = filePosition >= 0 ? Number(process.argv[filePosition + 1]) : 0;
if ((comicPosition >= 0 || filePosition >= 0 || provider === 'getcomics') && (!publicOnly || provider !== 'getcomics' ||
  !/^[1-9]\d{0,11}$/.test(comicId) || !Number.isSafeInteger(fileIndex) || fileIndex < 0 || fileIndex >= 20 || chapterId || render)) {
  throw new Error('Comic checks require --public --provider getcomics --comic POST_ID and an optional --file-index from 0 to 19.');
}
let requestPath = chapterId ? `${provider}/chapter/${chapterId}/pages` : publicOnly ? `${provider}/search` : downloadLink ? t3 ? 'torbox/t3-link-probe' : 'torbox/link-probe' : 'torbox/list';
let params = chapterId ? {} : publicOnly ? (provider === 'mangadex' ? { q: 'Yotsuba', offset: 0 } : { q: 'One Piece', page: 1 }) : { kind };
if (comicId) {
  const response = await fetch(`https://getcomics.org/wp-json/wp/v2/posts/${comicId}?_fields=id,title,link,content`,
    { credentials: 'omit', signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`The normal public comic feed returned HTTP ${response.status}.`);
  const entry = mapGetComics(await metadataJson(response)), choice = entry.downloads[fileIndex];
  if (entry.id !== comicId || !choice) throw new Error('The public comic record did not contain that archive choice.');
  requestPath = 'getcomics/resolve'; params = { postId: comicId, index: fileIndex, selectedUrl: choice.url };
}
const keys = await webcrypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['encrypt', 'decrypt']);
const publicKey = to64(await webcrypto.subtle.exportKey('spki', keys.publicKey));
const id = `${Date.now()}-${webcrypto.randomUUID()}`;
await exec('gh', ['api', '--method', 'POST', `repos/${repo}/actions/workflows/runtime.yml/dispatches`,
  '-f', 'ref=main', '-f', `inputs[request_id]=${id}`, '-f', `inputs[path]=${requestPath}`,
  '-f', `inputs[params]=${JSON.stringify(params)}`, '-f', `inputs[public_key]=${publicKey}`]);
console.log(`Dispatched encrypted ${publicOnly ? 'public catalog' : 'TorBox'} runtime check: ${id}`);
const deadline = Date.now() + 8 * 60 * 1000;
while (Date.now() < deadline) {
  let response;
  try { response = JSON.parse((await exec('gh', ['api', `repos/${repo}/contents/requests/${id}.json?ref=runtime-results`])).stdout); }
  catch (error) { if (!String(error.stderr).includes('404')) throw new Error('Runtime result could not be read.'); }
  if (response) {
    const envelope = JSON.parse(Buffer.from(response.content, 'base64').toString());
    const result = await openSealedResult(envelope, keys.privateKey);
    if (result.requestId !== id || result.expiresAt < Date.now() || result.error) throw new Error(result.error || 'Response identity/expiry mismatch.');
    if (downloadLink) {
      if (!httpsUrl(result.data.url) || result.data.kind !== (t3 ? 't3' : kind) || !Number.isSafeInteger(result.data.fileSize) || result.data.fileSize < 4096) {
        throw new Error('The private runtime returned an invalid range-check link.');
      }
      const { browserSession } = await import('../tests/helpers/browser-session.mjs');
      const browser = await browserSession(), base = process.env.UBR_SITE_URL || 'https://jayeshpaluru.github.io/unified-book-registry/';
      try {
        await browser.command('Page.navigate', { url: base });
        await browser.waitFor('!!document.querySelector("#view h1")');
        // Catch inside the browser so exceptions cannot echo a private URL.
        const proof = await browser.evaluate(`(${probeTorboxRange.toString()})(${JSON.stringify(result.data.url)},${result.data.fileSize})
          .then(proof=>({proof}),error=>({error:error.message}))`);
        if (proof.error) throw new Error(proof.error);
        console.log(`Live TorBox ${t3 ? 'T3 signed-link' : 'temporary-link'} check passed from Pages: HTTP ${proof.proof.status}, ${proof.proof.bytes} bytes, exposed Content-Range and matching total size. Private names, links and content withheld. This tests an existing file, not the finalized Anna index.`);
      } finally { await browser.close(); }
    } else if (comicId) {
      if (!httpsUrl(result.data.url) || new URL(result.data.url).hostname !== result.data.host) throw new Error('Invalid resolved public archive destination.');
      console.log('Live GetComics link resolver passed: trusted HTTPS destination reached with HEAD requests only. No comic archive body or TorBox operation performed.');
    } else if (chapterId) {
      const pages = provider === 'mangadex' ? mangaDexPages(result.data) : result.data.pages;
      if (!Array.isArray(pages) || !pages.length || pages.length > 2000) throw new Error('The public provider returned an invalid page manifest.');
      if (render) {
        const { browserSession } = await import('../tests/helpers/browser-session.mjs');
        const browser = await browserSession(), base = process.env.UBR_SITE_URL || 'https://jayeshpaluru.github.io/unified-book-registry/';
        try {
          await browser.command('Page.navigate', { url: base });
          await browser.waitFor('!!document.querySelector("#view h1")');
          await browser.evaluate(`import(${JSON.stringify(new URL('js/reader/image-reader.js', base).href)}).then(ui => {
            const host=document.createElement('div');host.id='public-provider-smoke';document.body.append(host);
            const pages=${JSON.stringify(pages)};
            window.publicReader=ui.mountImageReader(host,{item:{title:'Public provider smoke',mode:'ltr'},source:{count:pages.length,getUrl:async i=>pages[i],release(){}},onPage(){},onSettings(){},onClose(){}});
          })`);
          await browser.waitFor('document.querySelector("#public-provider-smoke .ir-stage img")?.naturalWidth > 0 || !!document.querySelector("#public-provider-smoke .notice")');
          const proof = await browser.evaluate(`({rendered:!!document.querySelector('#public-provider-smoke .ir-stage img')?.naturalWidth,
            pageLabel:document.querySelector('#public-provider-smoke .ir-label')?.textContent})`);
          if (!proof.rendered || proof.pageLabel !== `1 / ${pages.length}`) throw new Error('The public runtime manifest did not render in the actual Pages reader.');
          console.log(`Live ${provider} runtime and Pages reader passed: ${pages.length} public page references; first page rendered. No TorBox account operation performed.`);
        } finally { await browser.close(); }
      } else {
        const page = await fetch(pages[0], { method: 'HEAD', signal: AbortSignal.timeout(30000) });
        if (!page.ok || provider === 'mangadex' && !page.headers.get('content-type')?.startsWith('image/')) throw new Error('The image host could not serve the available chapter.');
        console.log(`Live ${provider} chapter runtime passed: ${pages.length} page references, first image HEAD ${page.status}. No chapter image body or TorBox account data downloaded.`);
      }
    } else console.log(publicOnly ? `Live ${provider} catalog runtime passed: ${(result.data.data || result.data.items).length} public results through an encrypted response. No TorBox account data queried.`
      : `Live runtime passed: ${result.data.items.length} TorBox downloads returned through an encrypted response. Private names and links withheld.`);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
if (Date.now() >= deadline) throw new Error('Live runtime check timed out. Inspect the existing workflow run before retrying.');
