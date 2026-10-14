import { CdpConn, getBrowserWs } from './src/cdp.mjs';
const conn = new CdpConn(await getBrowserWs(9223));
await conn.whenOpen();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sid = null;
for (let i = 0; i < 12 && !sid; i++) {
  const { targetInfos } = await conn.send('Target.getTargets');
  for (const c of targetInfos.filter((t) => t.type === 'page' && /player\.html/.test(t.url))) {
    const { sessionId: s } = await conn.send('Target.attachToTarget', { targetId: c.targetId, flatten: true });
    await conn.send('Page.enable', {}, s);
    const p = await conn.send('Runtime.evaluate', { expression: '!!(window.__ears&&window.__ears.state)', returnByValue: true }, s);
    if (p.result?.value) { sid = s; break; }
  }
  if (!sid) await sleep(4000);
}
if (!sid) { console.log('no injected player window'); process.exit(1); }
await conn.send('Page.navigate', { url: 'https://bilipc.bilibili.com/player.html?bvid=BV1KcQrBsEej' }, sid);
const EXPR = `JSON.stringify((()=>{
  const st = __ears.state;
  const m = st.segments[Math.floor(st.segments.length / 2)] || {};
  const rail = (document.getElementById('ears-host') && document.getElementById('ears-host').shadowRoot.querySelector('.status').textContent) || '';
  return { en: st.enSents && st.enSents.length, segs: st.segments.length, pending: st.asrPending,
           pct: +(st.asrPct || 0).toFixed(2), note: st.enNote || '', rail, mid: (m.en || m.zh || '').slice(0, 44) };
})())`;
const rd = async () => {
  const r = await conn.send('Runtime.evaluate', { expression: EXPR, returnByValue: true }, sid);
  return JSON.parse(r.result?.value || '{}');
};
for (let i = 0; i < 30; i++) {
  await sleep(12000);
  const o = await rd();
  console.log(`${(i + 1) * 12}s segs=${o.segs} en=${o.en} pct=${o.pct} rail=${JSON.stringify(o.rail)}`);
  if (!o.pending && (o.en === null || o.note)) { console.log('FINAL:', JSON.stringify(o)); break; }
}
process.exit(0);
