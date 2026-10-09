import { h } from './dom.js';
import { githubJob, hasGithubSession } from '../sources/github-jobs.js';
import { fileActions } from './anna-downloads.js';

export function getComicsDownloads(entry) {
  const status = h('p', { class: 'muted', role: 'status' });
  const files = h('div', { class: 'menu' });
  const body = h('section', {}, h('h2', {}, 'Read through TorBox'),
    h('p', { class: 'muted' }, 'Choose an archive host to add this comic to TorBox. Once ready, import and read its file here. Host availability and your account limits apply.'), status, files);
  if (!entry.downloads?.length) {
    body.append(h('p', { class: 'muted' }, 'This catalog entry does not include a supported archive link.'));
    return body;
  }
  for (const [index, download] of entry.downloads.entries()) {
    let submission;
    const state = h('p', { class: 'muted', role: 'status' });
    const matches = h('div', { class: 'import' });
    const check = h('button', { class: 'btn', hidden: true, onClick: async () => {
      check.disabled = true; state.textContent = 'Checking the submitted comic in TorBox…';
      try {
        const result = await githubJob('torbox/list', { kind: 'webdl' });
        const item = result.items.find((item) => item.id === submission);
        matches.replaceChildren(...(item?.files || []).filter((file) => /\.(cbz|zip|cbr|rar|pdf)$/i.test(file.name || '')).map((file) =>
          h('button', { class: 'btn', disabled: !item.ready, onClick: () => fileActions(entry,
            { ...file, kind: 'webdl', downloadId: item.id, ready: item.ready }) }, `${file.name.split('/').pop()} · Read / download here`)));
        state.textContent = item?.ready ? 'Ready files are available below.' : 'The file is not ready yet. Check again later.';
      } catch (error) { state.textContent = error.message; }
      finally { check.disabled = false; }
    } }, 'Check ready files');
    const add = h('button', { class: 'btn', onClick: async () => {
      if (!hasGithubSession()) { state.textContent = 'Connect your GitHub Actions session in Settings first.'; return; }
      add.disabled = true; state.textContent = 'Resolving this archive host and submitting it to TorBox…';
      try {
        const result = await githubJob('torbox/add-getcomics', { postId: entry.id, index, selectedUrl: download.url });
        submission = result.id; check.hidden = false; add.textContent = 'Submitted to TorBox';
        state.textContent = 'Submitted. Check ready files to open the comic here.';
      } catch (error) { state.textContent = error.message; add.disabled = false; }
    } }, `Send ${download.label} to TorBox`);
    body.append(h('div', {}, h('p', { class: 'muted' }, new URL(download.url).hostname), h('div', { class: 'import' }, add, check), state, matches));
  }
  return body;
}
