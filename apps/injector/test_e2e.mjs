// E2E: open a TED video in the client, verify ears state + overlay, take screenshots.
import { CdpConn, getBrowserWs } from './src/cdp.mjs';
import { writeFileSync } from 'node:fs';

const PORT = 9223;
const BV = process.argv[2] || 'BV1m14y1h7Ah';
const conn = new CdpConn(await getBrowserWs(PORT));
await conn.whenOpen();

// find or create the player window
let { targetInfos } = await conn.send('Target.getTargets');
let player = targetInfos.find((t) => t.type === 'page' && t.url.includes('player.html'));
let sessionId;
if (player) {
  ({ sessionId } = await conn.send('Target.attachToTarget', { targetId: player.targetId, flatten: true }));
} else {
  const created = await conn.send('Target.createTarget', { url: `https://bilipc.bilibili.com/player.html?bvid=${BV}` });
  ({ sessionId } = await conn.send('Target.attachToTarget', { targetId: created.targetId, flatten: true }));
}
const S = (m, p) => conn.send(m, p, sessionId);
await S('Page.enable');
if (player) {
  await S('Page.navigate', { url: `https://bilipc.bilibili.com/player.html?bvid=${BV}` });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(9000);

const snap = async (t) => {
  await S('Runtime.evaluate', { expression: `document.querySelector('video').currentTime = ${t}` });
  await sleep(1200);
  const shot = await S('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`C:/Qoder/ears/recon/out/shot_t${t}.png`, Buffer.from(shot.data, 'base64'));
};

const report = await S('Runtime.evaluate', { expression: `JSON.stringify((() => {
  const e = window.__ears;
  if (!e) return { ears: false };
  const st = e.state;
  const rootEl = document.querySelector('#ears-host');
  const seg = st.segments[st.idx] || null;
  return {
    ears: true,
    segments: st.segments.length,
    zh: st.zhSents?.length || 0,
    en: st.enSents?.length || 0,
    idx: st.idx,
    aid: st.aid, cid: st.cid,
    audioUrl: st.audioUrl.slice(0, 60),
    sidecarUp: st.sidecarUp,
    hostAttached: !!rootEl,
    enText: seg?.en || null,
    zhText: seg?.zh || null,
    t: document.querySelector('video')?.currentTime,
    nativeSubHidden: !!document.querySelector('style[data-ears]') || document.documentElement.classList.contains('ears-hide-native'),
  };
})())`, returnByValue: true });
console.log(JSON.parse(report.result.value));

await snap(3);
await snap(30);
await snap(60);
console.log('screenshots saved');
process.exit(0);
