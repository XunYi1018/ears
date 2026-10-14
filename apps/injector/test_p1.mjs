// P1 acceptance: latency distribution, sentence nav via real key events, toggles.
import { CdpConn, getBrowserWs } from './src/cdp.mjs';

const PORT = 9223;
const BV = process.argv[2] || 'BV1m14y1h7Ah';
const conn = new CdpConn(await getBrowserWs(PORT));
await conn.whenOpen();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
await S('Runtime.enable');
if (player) await S('Page.navigate', { url: `https://bilipc.bilibili.com/player.html?bvid=${BV}` });
await sleep(9000);
// verify we are really on the requested video; retry once via aid/cid of the recon video
let check = await S('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
if (!/773397711|BV1m14y1h7Ah/.test(check.result.value) && process.argv[3] !== '--any') {
  console.log('wrong video loaded, retrying direct aid/cid:', check.result.value.slice(0, 80));
  await S('Page.navigate', { url: 'https://bilipc.bilibili.com/player.html?type=ugc&aid=773397711&cid=26697140709&bvid=BV1m14y1h7Ah&page=1' });
  await sleep(9000);
}

const ev = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval fail');
  return r.result?.value;
};

// -- make sure the layer is on (localStorage may hold a stale off state)
await ev(`window.__ears.setSettings({ enabled: true, showEn: true, showZh: true, intensive: false })`);

// -- block the client's focus-loss auto-pause for the measurement window only
await ev(`(() => {
  if (!window.__origPause) window.__origPause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function () {};
  const v = document.querySelector('video'); v.muted = true; v.play().catch(()=>{});
  return 'pause-blocked';
})()`);

// -- latency sampling: 60s of flip deltas (steady state, seeks excluded)
await sleep(60000);
await ev(`(() => { HTMLMediaElement.prototype.pause = window.__origPause; return 'restored'; })()`);
const dist = await ev(`(() => {
  const l = window.__ears.state.flipLog;
  if (!l.length) return { empty: true };
  const s = [...l].sort((a,b)=>a-b);
  const p = (q) => s[Math.min(s.length-1, Math.floor(s.length*q))];
  return { n: s.length, p50: p(.5), p95: p(.95), min: s[0], max: s[s.length-1] };
})()`);
console.log('reveal-latency ms:', JSON.stringify(dist));

// -- sentence nav via REAL keydown (capture-phase path)
const before = await ev(`JSON.stringify({t: document.querySelector('video').currentTime, idx: window.__ears.state.idx})`);
const pressKey = async (key, code, vk, modifiers = 0) => {
  for (const type of ['rawKeyDown', 'char', 'keyUp']) {
    await S('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, text: type === 'char' ? key : undefined });
  }
};
await pressKey(']', 'BracketRight', 221);
await sleep(700);
const after = await ev(`JSON.stringify({t: document.querySelector('video').currentTime, idx: window.__ears.state.idx})`);
console.log('nav ] :', before, '->', after);

await pressKey('[', 'BracketLeft', 219);
await sleep(700);
const back = await ev(`JSON.stringify({t: document.querySelector('video').currentTime, idx: window.__ears.state.idx})`);
console.log('nav [ :', back);

// -- toggles via Alt+E
await pressKey('e', 'KeyE', 69, 1); // Alt modifier = 1
await sleep(300);
const togg1 = await ev(`window.__ears.state.showEn`);
await pressKey('e', 'KeyE', 69, 1);
await sleep(300);
const togg2 = await ev(`window.__ears.state.showEn`);
console.log('Alt+E toggle:', togg1, '->', togg2);

// -- prev/next programmatic (logic-level)
const navJs = await ev(`(() => {
  const e = window.__ears;
  const t0 = document.querySelector('video').currentTime;
  e.doNext();
  const t1 = document.querySelector('video').currentTime;
  e.doPrev();
  e.doPrev();
  const t2 = document.querySelector('video').currentTime;
  return JSON.stringify({ nextJumpMs: Math.round((t1-t0)*1000), prevJumpMs: Math.round((t2-t1)*1000) });
})()`);
console.log('programmatic nav:', navJs);

process.exit(0);
