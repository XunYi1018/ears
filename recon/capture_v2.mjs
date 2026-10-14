// Reload the client player window and capture the wbi/v2 response body
// -> the definitive answer to "which subtitle tracks exist for an English video, logged in".
const CDP = 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const targets = await (await fetch(`${CDP}/json/list`)).json();
const t = targets.find(x => x.type === 'page' && x.url.includes('player.html') && x.url.includes('aid='));
if (!t) { console.log('player window not found'); process.exit(1); }
const playerUrl = t.url;
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); let v2Response = null;
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
    if (/\/x\/player\/wbi\/v2/.test(m.params.response.url)) v2Response = m.params.requestId;
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
await send('Network.enable');
await send('Page.enable');
await send('Page.navigate', { url: playerUrl });
for (let i = 0; i < 20 && !v2Response; i++) await sleep(500);
if (!v2Response) { console.log('wbi/v2 not seen after 10s'); process.exit(1); }
const body = await send('Network.getResponseBody', { requestId: v2Response });
const j = JSON.parse(body.body);
const subs = j?.data?.subtitle || {};
console.log('need_login_subtitle:', subs.need_login_subtitle);
console.log('subtitles:', JSON.stringify((subs.subtitles || []).map(s => ({
  lan: s.lan, lan_doc: s.lan_doc, ai_type: s.ai_type, ai_status: s.ai_status,
  url: (s.subtitle_url || '').slice(0, 90),
})), null, 1));
// 若有可用轨，直接抓第一条字幕体看看格式
const first = (subs.subtitles || []).find(s => s.subtitle_url);
if (first) {
  const u = first.subtitle_url.startsWith('//') ? 'https:' + first.subtitle_url : first.subtitle_url;
  const sj = await (await fetch(u)).json();
  console.log('body lines:', sj.body?.length, 'first 2:', JSON.stringify(sj.body?.slice(0, 2), null, 1));
}
ws.close(); process.exit(0);
