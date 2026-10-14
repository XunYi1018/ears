// Try to drive the client's own player window via URL params.
const CDP = 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withTarget(urlPart, fn) {
  const targets = await (await fetch(`${CDP}/json/list`)).json();
  const t = targets.find(x => x.type === 'page' && x.url.includes(urlPart));
  if (!t) throw new Error('no target ' + urlPart);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const events = [];
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    } else if (m.method) events.push(m);
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  try { return await fn(send, events); } finally { ws.close(); }
}

const BV = 'BV1m14y1h7Ah';
const attempts = [
  `https://bilipc.bilibili.com/player.html?bvid=${BV}`,
  `https://bilipc.bilibili.com/player.html?bvid=${BV}&page=1&high_quality=1`,
  `https://bilipc.bilibili.com/player.html?aid=773397711&cid=26697140709`,
];

for (const url of attempts) {
  console.log('nav attempt:', url);
  await withTarget('player.html', async (send) => {
    await send('Page.enable');
    await send('Page.navigate', { url });
    await sleep(4500);
    const r = await send('Runtime.evaluate', { expression: `JSON.stringify({
      href: location.href,
      videoCount: document.querySelectorAll('video').length,
      videoReady: (document.querySelector('video')||{}).readyState ?? null,
      videoDuration: (document.querySelector('video')||{}).duration ?? null,
      bodyHint: (document.body.innerText||'').slice(0,120).replace(/\\n/g,' '),
    })`, returnByValue: true });
    console.log('  ->', r.result.value);
  });
}
