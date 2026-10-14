// Deep-dive the loaded player window: subtitle tracks, network traces, player globals.
const CDP = 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const targets = await (await fetch(`${CDP}/json/list`)).json();
const t = targets.find(x => x.type === 'page' && x.url.includes('player.html') && x.url.includes('aid='));
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const netResponses = [];
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  } else if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url;
    if (/subtitle|player\/(wbi\/)?v2|dm\b/.test(u)) netResponses.push({ url: u.slice(0, 140), status: m.params.response.status });
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
await send('Network.enable');
// 触发一次播放，让字幕相关请求发生
await send('Runtime.evaluate', { expression: `(() => { const v = document.querySelector('video'); v && v.play().catch(()=>{}); return 'ok'; })()` });
await sleep(2500);

const r = await send('Runtime.evaluate', { expression: `JSON.stringify({
  playerType: typeof window.player,
  playerKeys: window.player ? Object.keys(window.player).slice(0, 30) : null,
  perf: performance.getEntriesByType('resource').map(e => e.name)
        .filter(n => /subtitle|player\\/v2|player\\/wbi/.test(n)).slice(0, 8),
  textTracks: [...document.querySelectorAll('video')].flatMap(v =>
    [...v.textTracks].map(tt => ({ kind: tt.kind, label: tt.label, lang: tt.language, mode: tt.mode, cues: tt.cues ? tt.cues.length : null }))),
  trackEls: document.querySelectorAll('track').length,
  subtitleDom: [...document.querySelectorAll('[class*=subtitle i]')].slice(0, 4).map(e => ({ cls: e.className.slice(0, 60), text: (e.innerText || '').slice(0, 60) })),
  videoClasses: [...document.querySelectorAll('video')].map(v => v.className),
  playerRoot: [...document.querySelectorAll('[class*=player i]')].slice(0, 3).map(e => e.className.slice(0, 70)),
}, null, 1)`, returnByValue: true });
console.log(r.result.value);
console.log('CDP-observed subtitle-related responses:', JSON.stringify(netResponses, null, 1));
ws.close(); process.exit(0);
