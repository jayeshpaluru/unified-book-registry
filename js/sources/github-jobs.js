import { gunzipSync } from '../../vendor/fflate.js';
export const DEFAULT_REPO = 'jayeshpaluru/unified-book-registry';
let sessionToken = '';
let repo = DEFAULT_REPO;
const from64 = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
export const to64 = (bytes) => btoa(Array.from(new Uint8Array(bytes), (byte) => String.fromCharCode(byte)).join(''));
export const hasGithubSession = () => Boolean(sessionToken);
export const forgetGithubSession = () => { sessionToken = ''; };

async function github(path, init = {}) {
  const response = await fetch(`https://api.github.com/${path}`, { ...init, headers: {
    Accept: 'application/vnd.github+json', Authorization: `Bearer ${sessionToken}`, 'X-GitHub-Api-Version': '2022-11-28',
    ...(init.body && { 'Content-Type': 'application/json' }) }, signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (response.status === 404 && init.allowMissing) return null;
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}. Check the token’s repository access and Actions permissions.`);
  return response.status === 204 ? null : response.json();
}

export async function connectGithub(token, repository = DEFAULT_REPO) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Use an owner/repository name.');
  sessionToken = token.trim(); repo = repository;
  if (!sessionToken) throw new Error('Enter a repository-scoped GitHub token.');
  try {
    const user = await github('user');
    if (user.login.toLowerCase() !== repo.split('/')[0].toLowerCase()) throw new Error('Connect as the owner of this personal registry repository.');
    await github(`repos/${repo}/actions/workflows/runtime.yml`);
    return user.login;
  } catch (error) { forgetGithubSession(); throw error; }
}

export async function openSealedResult(envelope, privateKey) {
  if (envelope.version !== 1) throw new Error('Unsupported encrypted response.');
  const rawKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, from64(envelope.key));
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(envelope.iv) }, key, from64(envelope.data));
  return JSON.parse(new TextDecoder().decode(gunzipSync(new Uint8Array(bytes))));
}

export async function githubJob(path, params = {}, { signal, onProgress = () => {}, timeoutMs = 8 * 60 * 1000 } = {}) {
  if (!hasGithubSession()) throw new Error('Live requests need a GitHub Actions session. Connect in Settings, or open the provider’s own reader.');
  const tokenAtStart = sessionToken;
  const keys = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['encrypt', 'decrypt']);
  const requestId = `${Date.now()}-${crypto.randomUUID()}`;
  const publicKey = to64(await crypto.subtle.exportKey('spki', keys.publicKey));
  await github(`repos/${repo}/actions/workflows/runtime.yml/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main',
    inputs: { request_id: requestId, path, params: JSON.stringify(params), public_key: publicKey } }) });
  onProgress('Waiting for GitHub Actions… This usually takes 20–60 seconds.');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (!sessionToken || tokenAtStart !== sessionToken) throw new Error('GitHub session ended.');
    const file = await github(`repos/${repo}/contents/requests/${requestId}.json?ref=runtime-results`, { allowMissing: true });
    if (file) {
      const blob = file.content ? file : await github(`repos/${repo}/git/blobs/${file.sha}`);
      const envelope = JSON.parse(new TextDecoder().decode(from64(blob.content.replace(/\s/g, ''))));
      const result = await openSealedResult(envelope, keys.privateKey);
      if (result.requestId !== requestId || result.expiresAt < Date.now()) throw new Error('The encrypted response is expired or belongs to another request.');
      if (result.error) throw new Error(result.error);
      return result.data;
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(done, 5000);
      function done() { signal?.removeEventListener('abort', abort); resolve(); }
      function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason); }
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  throw new Error('The workflow is still pending or failed. Check its run on GitHub; Retry starts a new request.');
}
