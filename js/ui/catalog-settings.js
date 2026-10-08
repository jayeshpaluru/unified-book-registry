import { h, toast } from './dom.js';
import * as db from '../db.js';
import { DEFAULT_CATALOG_URL, validateCatalogUrl, catalogMode } from '../sources/catalog-api.js';
import * as anna from '../sources/anna.js';
import { connectGithub, forgetGithubSession, hasGithubSession, DEFAULT_REPO } from '../sources/github-jobs.js';
import { annaIndexSettings } from './anna-index-settings.js';

export async function catalogSettings() {
  const savedMode = await db.getSetting('catalogMode', 'auto');
  const mode = h('select', { 'aria-label': 'Catalog connection mode' }, [['auto', 'Automatic (static on hosted sites)'],
    ['static', 'Static catalog + GitHub Actions'], ['companion', 'Local catalog service']].map(([value, label]) => h('option', { value, selected: value === savedMode }, label)));
  const url = h('input', { type: 'url', value: await db.getSetting('catalogUrl', DEFAULT_CATALOG_URL), required: true,
    autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Catalog service URL' });
  const state = h('p', { class: 'muted', role: 'status' }, 'Checking catalog connection…');
  const importState = h('p', { class: 'muted', role: 'status' });
  let busy = false;
  async function check() {
    try {
      const status = await anna.status();
      state.textContent = `${status.remoteAnna ? 'Connected TorBox index' : status.static ? 'Static catalog' : 'Connected'} · ${status.annaRecords.toLocaleString()} Anna’s Archive records${status.importing ? ' · import running' : ''}.`;
      if (status.static) {
        state.append(h('p', {}, `Last public catalog sync: ${new Date(status.updatedAt).toLocaleString()}.`));
        for (const [name, provider] of Object.entries(status.providers)) state.append(h('p', {},
          `${name}: ${provider.records.toLocaleString()} entries · ${provider.status}. ${provider.coverage || provider.error || ''}`));
        if (!status.annaRecords) state.append(h('p', {}, 'Anna’s Archive metadata is not populated in this Pages snapshot or browser yet. Import metadata locally or connect a finalized TorBox index.'));
      }
    } catch (error) { state.textContent = await catalogMode() === 'static' ? error.message : 'Disconnected. Start your catalog service, then save its URL here.'; }
  }
  const connect = h('form', { onSubmit: async (event) => {
    event.preventDefault();
    try {
      await db.setSetting('catalogUrl', validateCatalogUrl(url.value.trim()));
      state.textContent = 'Checking connection…';
      await check();
    } catch (error) { toast(error.message); }
  } }, h('label', { class: 'field' }, h('span', {}, 'Catalog service URL'), url),
  h('button', { class: 'btn', type: 'submit' }, 'Save and check connection'));
  connect.hidden = await catalogMode() !== 'companion';
  mode.addEventListener('change', async () => {
    await db.setSetting('catalogMode', mode.value);
    connect.hidden = await catalogMode() !== 'companion';
    await check();
  });

  const file = h('input', { type: 'file', multiple: true, hidden: true, accept: '.json,.jsonl,.ndjson,.gz,.zst', onChange: async (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    if (busy || !files.length) return;
    busy = true; importButton.disabled = true;
    try {
      let imported = 0, skipped = 0;
      for (const metadata of files) {
        importState.textContent = `Importing ${metadata.name}… ${await catalogMode() === 'static' ? 'Keep this tab open; metadata stays in this browser.' : 'Keep the catalog service running.'}`;
        const result = await anna.importMetadata(metadata);
        imported += result.imported; skipped += result.skipped;
      }
      importState.textContent = `${imported.toLocaleString()} records imported${skipped ? `; ${skipped.toLocaleString()} unsupported records skipped` : ''}.`;
      await check();
    } catch (error) { importState.textContent = error.message; }
    finally { busy = false; importButton.disabled = false; }
  } });
  const importButton = h('button', { class: 'btn', onClick: () => file.click() }, 'Import Anna’s Archive metadata');
  const lang = h('input', { value: await db.getSetting('mangaLanguage', 'en'), placeholder: 'en',
    autocapitalize: 'off', autocomplete: 'off', pattern: '[a-z]{2}(-[a-z]{2})?', 'aria-label': 'Preferred translation language' });
  lang.addEventListener('change', () => {
    if (!lang.checkValidity()) { lang.reportValidity(); return; }
    db.setSetting('mangaLanguage', lang.value || 'en');
  });
  const section = h('section', {}, h('h2', {}, 'Books, comics and scanlation catalogs'),
    h('p', { class: 'muted' }, 'Hosted catalogs run without a local server. Live manga requests and private TorBox operations use GitHub Actions.'),
    h('label', { class: 'field' }, h('span', {}, 'Catalog connection mode'), mode),
    connect, state,
    h('div', { class: 'import' }, importButton, file), importState,
    h('p', { class: 'muted' }, 'Import combined aarecord/Elasticsearch JSON or JSONL, optionally gzip-compressed. Browser imports stay on this device and are separate from library backups. Zstandard needs the local CLI.'),
    h('a', { href: 'https://annas-archive.pk/datasets', target: '_blank', rel: 'noopener noreferrer' }, 'Anna’s Archive metadata sources ↗'),
    h('label', { class: 'field' }, h('span', {}, 'Preferred MangaDex translation language (e.g. en, es, pt-br)'), lang));
  const token = h('input', { type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: false,
    placeholder: 'Repository-scoped GitHub token', 'aria-label': 'GitHub session token' });
  const repository = h('input', { value: await db.getSetting('githubRepo', DEFAULT_REPO), autocomplete: 'off',
    autocapitalize: 'off', 'aria-label': 'GitHub repository' });
  const session = h('p', { class: 'muted', role: 'status' }, hasGithubSession() ? 'Connected for this tab.' : 'Not connected. Static catalog browsing still works.');
  const signIn = h('button', { type: 'submit', class: 'btn' }, 'Connect for this tab');
  section.append(h('h2', {}, 'Live catalogs and TorBox'),
    h('p', { class: 'muted' }, 'Create a fine-grained GitHub token for this repository only, with Actions: read/write and Contents: read. The token stays in memory, is excluded from backups, and is forgotten when this tab reloads. Never enter your TorBox key here.'),
    h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener noreferrer' }, 'Create a repository-scoped GitHub token ↗'),
    h('form', { onSubmit: async (event) => {
      event.preventDefault(); signIn.disabled = true; session.textContent = 'Checking GitHub access…';
      try {
        const login = await connectGithub(token.value, repository.value.trim());
        await db.setSetting('githubRepo', repository.value.trim()); session.textContent = `Connected as ${login} for this tab.`;
      } catch (error) { session.textContent = error.message; }
      finally { token.value = ''; signIn.disabled = false; }
    } }, h('label', { class: 'field' }, h('span', {}, 'GitHub repository'), repository),
    h('label', { class: 'field' }, h('span', {}, 'GitHub session token (not your TorBox key)'), token), signIn,
    h('button', { type: 'button', class: 'btn', onClick: () => { forgetGithubSession(); session.textContent = 'Session forgotten.'; token.value = ''; } }, 'Forget session')),
    session, h('p', { class: 'muted' }, 'Actions requests usually take 20–60 seconds to start. Private results are encrypted for this browser session before being stored in the public repo.'),
    h('a', { href: `https://github.com/${DEFAULT_REPO}/actions`, target: '_blank', rel: 'noopener noreferrer' }, 'Workflow status ↗'));
  section.append(annaIndexSettings(check));
  check();
  return section;
}
