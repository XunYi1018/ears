// Open a video through the client itself, then inspect the resulting player window.
const CDP = 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function evalIn(targetUrlPart, expression) {
  const targets = await (await fetch(`${CDP}/json/list`)).json();
  const t = targets.find(x => x.type === 'page' && x.url.includes(targetUrlPart));
  if (!t) return { err: `no target matching ${targetUrlPart}` };
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  ws.close();
  return r.result?.value ?? r.result;
}

console.log('shell:', await evalIn('index.html',
  `JSON.stringify({opened: !!window.open('https://www.bilibili.com/video/BV1m14y1h7Ah/')} )`));
await sleep(6000);

const targets = await (await fetch(`${CDP}/json/list`)).json();
for (const t of targets) console.log('target:', t.type, t.url.slice(0, 110));

const playerUrl = targets.find(t => t.type === 'page' && t.url.includes('player.html') && t.url.includes('BV'))?.url
  || targets.filter(t => t.type === 'page' && t.url.includes('player.html')).map(t => t.url).join(' || ');
console.log('player target url:', playerUrl);

const info = await evalIn('player.html', `JSON.stringify({
  href: location.href,
  videoCount: document.querySelectorAll('video').length,
  loggedUid: (document.cookie.match(/DedeUserID=(\\d+)/) || [])[1] || null,
  playerType: typeof window.player,
  playerKeys: window.player ? Object.keys(window.player).slice(0, 20) : null,
  hasInitialState: typeof window.__INITIAL_STATE__,
  initialStateKeys: window.__INITIAL_STATE__ ? Object.keys(window.__INITIAL_STATE__).slice(0, 25) : null,
  subtitleState: window.__INITIAL_STATE__ && window.__INITIAL_STATE__.videoData ? JSON.stringify(window.__INITIAL_STATE__.videoData.subtitle).slice(0, 400) : null,
  perfSubUrls: performance.getEntriesByType('resource').map(e => e.name).filter(n => /aisubtitle|subtitle|wbi\\/v2/.test(n)).slice(0, 6),
})`);
console.log('player page info:', JSON.stringify(info, null, 1));
