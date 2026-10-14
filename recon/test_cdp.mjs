// CDP attach smoke test against the running Bilibili client.
const CDP = 'http://127.0.0.1:9223';
const targets = await (await fetch(`${CDP}/json/list`)).json();
const player = targets.find(t => t.type === 'page' && t.url.includes('player.html'))
  || targets.find(t => t.type === 'page');
if (!player) { console.log('NO PAGE TARGET'); process.exit(1); }
console.log('attaching:', player.url);

const ws = new WebSocket(player.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id;
  pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

const r = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    href: location.href,
    title: document.title,
    hasVideo: !!document.querySelector('video'),
    videoCount: document.querySelectorAll('video').length,
    loggedUid: (document.cookie.match(/DedeUserID=(\\d+)/) || [])[1] || null,
    hasInitialState: typeof window.__INITIAL_STATE__,
    playerKeys: window.player ? Object.keys(window.player).slice(0, 12) : null,
    bilibiliApi: typeof window.bilibili,
    sdkKeys: window.bilibili && window.bilibili.browser ? Object.keys(window.bilibili.browser).slice(0, 10) : null,
  })`,
  returnByValue: true,
});
console.log(r.result.value);
ws.close();
process.exit(0);
