// Two-scenario check on the real client:
//  A) Chinese-narrated lesson  -> must NOT fake an English line; must say why
//  B) English talk (cached ASR) -> must show real English + merged Chinese
import { CdpConn, getBrowserWs } from 'file:///C:/Qoder/ears/apps/injector/src/cdp.mjs';

const conn = new CdpConn(await getBrowserWs(9223));
await conn.whenOpen();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attachFresh() {
  const { targetInfos } = await conn.send('Target.getTargets');
  const cands = targetInfos.filter((t) => t.type === 'page' && /player\.html/.test(t.url));
  for (const c of cands) {
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId: c.targetId, flatten: true });
    await conn.send('Page.enable', {}, sessionId);
    const probe = await conn.send('Runtime.evaluate', { expression: '!!(window.__ears&&window.__ears.state)', returnByValue: true }, sessionId);
    if (probe.result?.value) return sessionId;
  }
  return null;
}

const readState = (sid) => conn.send('Runtime.evaluate', {
  expression: `JSON.stringify((()=>{const st=__ears.state;const m=st.segments[Math.floor(st.segments.length/2)]||{};
    return {key:st.videoKey,en:st.enSents&&st.enSents.length,zh:st.zhSents&&st.zhSents.length,segs:st.segments.length,
      pending:st.asrPending,pct:+(st.asrPct||0).toFixed(2),note:st.enNote||'',
      midEn:(m.en||'').slice(0,52),midZh:(m.zh||'').slice(0,22),
      rail:(__ears.state.segments.length? '':'')+ (document.getElementById('ears-host')?.shadowRoot?.querySelector('.status')?.textContent||'')};})())`,
  returnByValue: true,
}, sid);

let sid = await attachFresh();
if (!sid) { console.log('no injected player window yet'); process.exit(1); }

console.log('=== A) Chinese-narrated lesson (BV1KcQrBsEej) ===');
await conn.send('Page.navigate', { url: 'https://bilipc.bilibili.com/player.html?bvid=BV1KcQrBsEej' }, sid);
for (let i = 0; i < 24; i++) {
  await sleep(10000);
  const r = JSON.parse((await readState(sid)).result.value || '{}');
  console.log(`${(i + 1) * 10}s en=${r.en} zh=${r.zh} segs=${r.segs} pending=${r.pending} pct=${r.pct} rail="${r.rail}"`);
  if (!r.pending && (r.en === null || r.en === 0 || r.note)) { console.log('   note:', r.note, '| mid:', r.midEn); break; }
}
let a = JSON.parse((await readState(sid)).result.value);
console.log('A result:', JSON.stringify({ en: a.en, segs: a.segs, note: a.note, rail: a.rail, midEn: a.midEn }));

console.log('=== B) English talk with cached ASR (aid 346149097) ===');
await conn.send('Page.navigate', { url: 'https://bilipc.bilibili.com/player.html?type=ugc&aid=346149097&cid=26737967108' }, sid);
await sleep(14000);
for (let i = 0; i < 20; i++) {
  const r = JSON.parse((await readState(sid)).result.value || '{}');
  if (r.en) { console.log(`B: en=${r.en} segs=${r.segs} mid="${r.midEn}" zh="${r.midZh}"`); break; }
  console.log(`   waiting… en=${r.en} pending=${r.pending} pct=${r.pct} key=${r.key}`);
  await sleep(10000);
}
let b = JSON.parse((await readState(sid)).result.value);
console.log('B result:', JSON.stringify({ en: b.en, zh: b.zh, segs: b.segs, midEn: b.midEn, midZh: b.midZh, note: b.note }));
process.exit(0);
