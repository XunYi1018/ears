// Real-input acceptance: genuine key events + a genuine mouse click on a word,
// exactly the paths the user's keyboard and mouse take.
import { CdpConn, getBrowserWs } from 'file:///C:/Qoder/ears/apps/injector/src/cdp.mjs';

const PORT = 9223;
const conn = new CdpConn(await getBrowserWs(PORT));
await conn.whenOpen();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let { targetInfos } = await conn.send('Target.getTargets');
const players = targetInfos.filter((t) => t.type === 'page' && t.url.includes('player.html'));
// the client keeps an empty placeholder player window around; skip it
let sessionId = null;
for (const cand of players) {
  const { sessionId: sid } = await conn.send('Target.attachToTarget', { targetId: cand.targetId, flatten: true });
  const ok = await conn.send('Runtime.evaluate', { expression: '!!(window.__ears && window.__ears.state)', returnByValue: true }, sid);
  if (ok.result?.value) { sessionId = sid; console.log('using target', cand.url.slice(0, 70)); break; }
}
if (!sessionId) { console.log('NO injected player window found; targets:', players.map((p) => p.url.slice(0, 60))); process.exit(1); }
const S = (m, p) => conn.send(m, p, sessionId);
await S('Page.enable');
await S('Runtime.enable');
const ev = async (script) => {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const r = await S('Runtime.evaluate', { expression: `eval(atob(${JSON.stringify(b64)}))`, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) return 'EXC ' + (r.exceptionDetails.exception?.description || '').slice(0, 200);
  return r.result?.value;
};
const key = async (k, code, vk, modifiers = 0) => {
  const types = k.length === 1 ? ['rawKeyDown', 'char', 'keyUp'] : ['rawKeyDown', 'keyUp'];
  for (const type of types) {
    await S('Input.dispatchKeyEvent', {
      type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
      text: type === 'char' ? k : undefined,
    });
  }
};
const st = () => ev(`JSON.stringify((()=>{const s=__ears.state,v=document.querySelector('video');return {
  enabled:s.enabled,showEn:s.showEn,showZh:s.showZh,intensive:s.intensive,reveal:s.reveal,
  segs:s.segments.length,en:s.enSents&&s.enSents.length,zh:s.zhSents&&s.zhSents.length,
  idx:s.idx,t:v&&+v.currentTime.toFixed(2),paused:v&&v.paused,loop:s.loopCount,off:s.offsetMs};})())`);

console.log('--- 0. wait for EN (ASR) ---');
for (let i = 0; i < 30; i++) {
  const o = JSON.parse(await ev(`JSON.stringify({en:__ears.state.enSents&&__ears.state.enSents.length,pending:__ears.state.asrPending})`));
  if (o.en) { console.log(`EN ready after ${i * 6}s:`, o.en, 'sentences'); break; }
  if (i === 29) console.log('EN still pending after 180s', JSON.stringify(o));
  await sleep(6000);
}

console.log('--- 1. keep the client from pausing us, then play ---');
console.log(await ev(`(() => {
  const v = document.querySelector('video');
  delete v.pause;
  if (!window.__origPause) window.__origPause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function () {
    const s = new Error().stack || '';
    if (s.includes('/assets/')) return;
    return window.__origPause.call(this);
  };
  v.muted = true;
  v.currentTime = 30;
  v.play().catch(() => {});
  return 'playing';
})()`));
await sleep(2500);
console.log('before:', await st());

console.log('--- 2. real key: ] next sentence ---');
const b1 = JSON.parse(await st());
await key(']', 'BracketRight', 221);
await sleep(900);
const a1 = JSON.parse(await st());
console.log(`t ${b1.t} -> ${a1.t}, idx ${b1.idx} -> ${a1.idx}`);

console.log('--- 3. real key: [ prev sentence ---');
await key('[', 'BracketLeft', 219);
await sleep(900);
console.log('after [:', await st());

console.log('--- 4. real key: Alt+E (english off/on) ---');
const e0 = JSON.parse(await st());
await key('e', 'KeyE', 69, 1);
await sleep(500);
const e1 = JSON.parse(await st());
await key('e', 'KeyE', 69, 1);
await sleep(500);
const e2 = JSON.parse(await st());
console.log(`showEn ${e0.showEn} -> ${e1.showEn} -> ${e2.showEn}`);
console.log('en line visible when off?', await ev(`(() => {
  const sr = document.getElementById('ears-host').shadowRoot;
  const en = sr.querySelector('.en');
  const before = getComputedStyle(en).display + '/' + en.textContent.slice(0,12);
  return before;
})()`));

console.log('--- 5. real key: Alt+C (chinese) ---');
const c0 = JSON.parse(await st());
await key('c', 'KeyC', 67, 1);
await sleep(500);
const c1 = JSON.parse(await st());
await key('c', 'KeyC', 67, 1);
await sleep(400);
console.log(`showZh ${c0.showZh} -> ${c1.showZh} -> ${(await JSON.parse(await st())).showZh}`);

console.log('--- 6. real key: Alt+S (master) ---');
await key('s', 'KeyS', 83, 1);
await sleep(500);
const s1 = JSON.parse(await st());
const hidden = await ev(`getComputedStyle(document.getElementById('ears-host').shadowRoot.querySelector('.root')).display`);
await key('s', 'KeyS', 83, 1);
await sleep(400);
console.log(`enabled ${s1.enabled} (root display=${hidden}) -> ${(await JSON.parse(await st())).enabled}`);

console.log('--- 7. real key: Alt+I intensive + reveal ladder ---');
await key('i', 'KeyI', 73, 1);
await sleep(400);
console.log('intensive on:', await st());
await ev(`(() => { const v=document.querySelector('video'); v.currentTime = __ears.state.segments[__ears.state.idx>=0?__ears.state.idx:0].start + 0.2; v.play().catch(()=>{}); return 1; })()`);
await sleep(6000);
console.log('after 6s (expect auto-pause at sentence end):', await st());
for (let i = 0; i < 3; i++) {
  await key('ArrowRight', 'ArrowRight', 39);
  await sleep(700);
  console.log(`  press -> ${i + 1}:`, await st());
}
await ev(`window.__ears.setSettings({ intensive: true, reveal: 0 }); 1`);
await sleep(300);

console.log('--- 8. real mouse click on a word ---');
const box = await ev(`(() => {
  const sr = document.getElementById('ears-host').shadowRoot;
  const spans = [...sr.querySelectorAll('.en span.w')];
  const target = spans.find(s => /[A-Za-z]{4,}/.test(s.textContent)) || spans[0];
  if (!target) return JSON.stringify({ err: 'no spans' });
  const r = target.getBoundingClientRect();
  const host = document.getElementById('ears-host').getBoundingClientRect();
  return JSON.stringify({ word: target.textContent, x: r.x + r.width / 2, y: r.y + r.height / 2 });
})()`);
const bx = JSON.parse(box);
console.log('word box:', JSON.stringify(bx));
if (bx.x != null) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await S('Input.dispatchMouseEvent', { type, x: bx.x, y: bx.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
  }
  await sleep(1500);
  console.log('tooltip:', await ev(`(document.getElementById('ears-host').shadowRoot.querySelector('.zh')||{}).textContent`));
}

console.log('--- 9. latency sample during real playback ---');
await ev(`__ears.state.flipLog = []; 1`);
await ev(`document.querySelector('video').play()`);
await sleep(20000);
console.log(await ev(`(() => { const l=__ears.state.flipLog; if(!l.length) return {empty:true};
  const s=[...l].sort((a,b)=>a-b); const p=q=>s[Math.min(s.length-1,Math.floor(s.length*q))];
  return {n:s.length,p50:p(.5),p95:p(.95),max:s[s.length-1]}; })()`));
console.log('restore pause:', await ev(`(() => { HTMLMediaElement.prototype.pause = window.__origPause; return 1; })()`));
process.exit(0);
