import { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

export async function browserSession({ intercept } = {}) {
  const path = process.env.UBR_BROWSER_PATH || ['/Applications/Helium.app/Contents/MacOS/Helium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
  if (!path) throw new Error('Set UBR_BROWSER_PATH to a Chromium executable.');
  const profile = mkdtempSync(join(tmpdir(), 'ubr-static-smoke-'));
  const downloadPath = join(profile, 'downloads'); mkdirSync(downloadPath);
  const child = spawn(path, ['--headless=new', '--no-first-run', '--disable-background-networking', '--disable-extensions',
    '--disable-default-apps', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = ''; const timer = setTimeout(() => reject(new Error('Browser startup timed out.')), 20000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.stderr.on('data', (chunk) => { stderr += chunk; const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0; const pending = new Map(), exceptions = [];
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) { reject(new Error('The isolated browser connection closed.')); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 45000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
  });
  const rejectPending = () => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('The isolated browser connection closed.')); }
    pending.clear();
  };
  socket.addEventListener('close', rejectPending); socket.addEventListener('error', rejectPending);
  socket.addEventListener('message', async (event) => {
    const message = JSON.parse(event.data);
    if (message.id) { const task = pending.get(message.id); pending.delete(message.id);
      clearTimeout(task?.timer);
      if (message.error) task?.reject(new Error(message.error.message)); else task?.resolve(message.result); }
    else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
    else if (message.method === 'Fetch.requestPaused' && intercept) {
      try {
        const response = await intercept(message.params.request);
        await send('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: response.status || 200,
          responseHeaders: Object.entries(response.headers || {}).map(([name, value]) => ({ name, value })),
          body: Buffer.from(response.body || '').toString('base64') }, message.sessionId);
      } catch (error) { exceptions.push(error.message); await send('Fetch.failRequest', { requestId: message.params.requestId, errorReason: 'Failed' }, message.sessionId).catch(() => {}); }
    }
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params) => send(method, params, sessionId);
  await command('Runtime.enable'); await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  async function evaluate(expression) {
    const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  }
  return { command, evaluate, exceptions, downloadPath, async waitFor(expression) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
    throw new Error(`UI wait timed out: ${expression}\n${await evaluate('document.body.innerText')}`);
  }, async close() {
    socket.close(); rejectPending();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      let timer;
      await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 5000); })]);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 5000); })]);
        clearTimeout(timer);
      }
    }
    rmSync(profile, { recursive: true, force: true });
  } };
}
