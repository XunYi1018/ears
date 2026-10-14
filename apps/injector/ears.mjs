#!/usr/bin/env node
// ears.mjs — start the Bilibili client with CDP enabled and inject the ears
// bundle into every page target (survives navigation while this process lives).
//   node ears.mjs              # start client + inject + stay alive
//   node ears.mjs --attach     # attach to an already-running client (port 9223)
import { spawn, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CdpConn, getBrowserWs } from './src/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = process.env.EARS_CLIENT || 'C:\\Program Files\\Bilibili\\哔哩哔哩.exe';
const PORT = process.env.EARS_PORT || '9223';
const readBundle = () => readFileSync(join(HERE, 'dist', 'ears.iife.js'), 'utf8');
let BUNDLE = '';

async function cdpUp(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
    return true;
  } catch { return false; }
}

function clientRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq 哔哩哔哩.exe" /NH', { encoding: 'utf8' });
    return /哔哩哔哩\.exe/i.test(out);
  } catch { return false; }
}

async function ensureClient() {
  if (await cdpUp(PORT)) {
    console.log(`[ears] CDP already up on ${PORT}`);
    return;
  }
  if (clientRunning()) {
    // running without CDP -> must restart (single-instance lock blocks a second launch)
    console.log('[ears] client is running WITHOUT cdp; killing for relaunch ...');
    try { execSync('taskkill /F /IM "哔哩哔哩.exe" /T'); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 2500));
  }
  console.log('[ears] launching client with --remote-debugging-port=' + PORT);
  // throttling switches: when the client window is occluded/minimized Chromium
  // throttles timers and stalls vfc, which would make subtitles drift seconds
  const SWITCHES = [
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ];
  const child = spawn(CLIENT, [`--remote-debugging-port=${PORT}`, ...SWITCHES], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function main() {
  BUNDLE = readBundle();
  await ensureClient();
  const wsUrl = await getBrowserWs(PORT);
  const conn = new CdpConn(wsUrl);
  await conn.whenOpen();
  console.log('[ears] attached to browser target');

  const injected = new Set();
  async function wireTo(targetInfo, sessionId) {
    if (targetInfo.type !== 'page' || injected.has(targetInfo.targetId)) return;
    injected.add(targetInfo.targetId);
    try {
      // runs on every future navigation while our session lives
      await conn.send('Page.enable', {}, sessionId);
      await conn.send('Page.addScriptToEvaluateOnNewDocument', { source: BUNDLE }, sessionId);
      // and run once right now for the already-loaded document
      await conn.send('Runtime.evaluate', {
        expression: BUNDLE,
        silent: true,
        userGesture: true,
      }, sessionId);
      console.log('[ears] injected ->', (targetInfo.url || '').slice(0, 80));
    } catch (e) {
      console.log('[ears] inject failed for', targetInfo.url?.slice(0, 60), e.message);
    }
  }

  // attach to every page now + auto-attach future targets (flatten sessions)
  conn.on(async (m) => {
    if (m.method === 'Target.attachedToTarget') {
      const { targetInfo, sessionId } = m.params;
      await wireTo(targetInfo, sessionId);
      // keep flattening deeper targets (iframes/webviews)
      await conn.send('Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId)
        .catch(() => {});
    }
  });

  const { targetInfos } = await conn.send('Target.getTargets');
  for (const t of targetInfos) {
    if (t.type !== 'page') continue;
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    await wireTo(t, sessionId);
  }
  await conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  console.log('[ears] ready — 注入生效中，保持本窗口开启即可');
  // stay attached until the browser goes away, then let the supervisor reconnect
  await new Promise((res) => {
    conn.ws.onclose = res;
    conn.ws.onerror = res;
    if (!conn.open) res();
  });
  console.log('[ears] 客户端已退出，等待重新打开…');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function supervisor() {
  process.on('SIGINT', () => { console.log('[ears] detach'); process.exit(0); });
  let failures = 0;
  for (;;) {
    try {
      await main();
      failures = 0;
    } catch (e) {
      failures++;
      console.log('[ears] session error:', e.message);
      if (failures >= 4) { console.log('[ears] 连续失败，停止重试'); return; }
    }
    await sleep(2000);
    // the user may reopen the client from its own icon (no CDP) — restart it with CDP
    await ensureClient();
  }
}

supervisor().catch((e) => { console.error('[ears] fatal:', e); process.exit(1); });
