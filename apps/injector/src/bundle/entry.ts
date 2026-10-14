// Ears injected bundle — runs inside the Bilibili client's player window.
// Data flow: sniff the player's own x/player/wbi/v2 + playurl responses ->
// fetch subtitle JSON (URL is self-authenticated) -> sentence re-segmentation
// (core) -> DOM overlay driven by requestVideoFrameCallback.
import { installPanel } from './panel';
import { linesToSentences, asrToSentences, mergeBilingual, findAt, prevSentence, nextSentence } from '../../../../packages/core/src/index';
import type { Sentence, BiliSubtitleBody, Word } from '../../../../packages/core/src/index';

(() => {
  const W = window as any;
  const startedAt = Date.now();
  if (W.__ears) {
    if (W.__ears.v >= 5) return;
    // stale instance from an older bundle: remove its DOM so we don't stack overlays
    try { W.__ears.teardown && W.__ears.teardown(); } catch {}
  }
  W.__ears = { v: 5 };
  const disposables: Array<() => void> = [];

  // ---------- state ----------
  const state = {
    enabled: true,
    showEn: true,
    showZh: true,
    intensive: false,
    reveal: 0, // 0 blind, 1 en, 2 zh
    loopCount: 1,
    segments: [] as Sentence[],
    enSents: null as Sentence[] | null,
    zhSents: null as Sentence[] | null,
    idx: -1,
    video: null as HTMLVideoElement | null,
    videoKey: '', // aid:cid
    aid: '',
    cid: '',
    enKey: '', // which video each dataset belongs to (SPA switches reuse the document)
    zhKey: '',
    audioKey: '',
    audioUrl: '', // for sidecar ASR
    asrPending: false,
    asrPct: 0,
    enNote: '',
    pausedThisSentence: false,
    loopsDone: 0,
    lastRender: -2,
    sidecarUp: null as boolean | null,
    flipDeltaMs: 0,
    flipLog: [] as number[],
    justSeeked: false,
    bottomPct: 13,
    fontSize: 26,
    offsetMs: 0,
  };

  try {
    const saved = JSON.parse(localStorage.getItem('ears.settings') || '{}');
    Object.assign(state, saved);
    state.reveal = 0;
  } catch { /* fresh */ }
  const persist = () => {
    const { enabled, showEn, showZh, intensive, loopCount, bottomPct, fontSize, offsetMs } = state;
    localStorage.setItem('ears.settings', JSON.stringify({ enabled, showEn, showZh, intensive, loopCount, bottomPct, fontSize, offsetMs }));
  };

  const log = (...a: unknown[]) => console.log('%c[ears]', 'color:#0af', ...a);

  function cjkRatio(text: string): number {
    if (!text) return 0;
    let n = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) n++;
    }
    return n / text.length;
  }

  // ---------- per-video data ownership ----------
  // The client switches videos with in-place SPA navigation (same document),
  // so every dataset carries the aid:cid it belongs to; anything stale is dropped.
  function setVideoKey(aid: string, cid: string) {
    if (!aid || !cid) return false;
    const key = `${aid}:${cid}`;
    if (key === state.videoKey) return false;
    log('video changed:', state.videoKey || '(none)', '->', key);
    state.videoKey = key;
    state.aid = aid;
    state.cid = cid;
    state.segments = [];
    state.enSents = null;
    state.zhSents = null;
    state.enKey = '';
    state.zhKey = '';
    state.audioUrl = '';
    state.audioKey = '';
    state.asrPending = false;
    state.idx = -1;
    state.lastRender = -2;
    state.reveal = 0;
    state.pausedThisSentence = false;
    state.loopsDone = 0;
    state.flipLog = [];
    if (state.audioUrl) { state.audioKey = key; maybeStartAsr(); }
    return true;
  }

  // ---------- data acquisition ----------
  function onPlayerV2(json: any, reqUrl: string) {
    const subs = json?.data?.subtitle?.subtitles || [];
    const aid = /aid=(\d+)/.exec(reqUrl)?.[1] || String(json?.data?.aid || '');
    const cid = /cid=(\d+)/.exec(reqUrl)?.[1] || String(json?.data?.cid || '');
    setVideoKey(aid, cid);
    if (aid) state.aid = aid;
    if (cid) state.cid = cid;
    if (!subs.length) { log('wbi/v2: no subtitle track (EN will come from ASR)'); refreshRail(); return; }
    const ownerKey = state.videoKey;
    for (const s of subs) {
      if (!s.subtitle_url) continue;
      const url = s.subtitle_url.startsWith('//') ? 'https:' + s.subtitle_url : s.subtitle_url;
      fetch(url)
        .then((r) => r.json())
        .then((body: BiliSubtitleBody) => ingestTrack(s.lan, body, ownerKey))
        .catch((e) => log('subtitle fetch fail', s.lan, e.message));
    }
  }

  function onPlayurl(json: any) {
    const auds = json?.data?.dash?.audio || [];
    if (!auds.length) return;
    const paids = json?.data?.aid || '';
    const pcids = json?.data?.cid || '';
    if (paids && pcids) setVideoKey(String(paids), String(pcids));
    const best = [...auds].sort((a, b) => (a.id || 0) - (b.id || 0))[0];
    state.audioUrl = best.baseUrl || best.base_url || '';
    // playurl can beat wbi/v2; leave audioKey empty and let setVideoKey adopt it
    state.audioKey = state.videoKey && (!state.audioKey || state.audioKey === state.videoKey) ? state.videoKey : '';
    log('audio stream captured:', state.audioUrl.slice(0, 80));
    maybeStartAsr();
  }

  function ingestTrack(lan: string, body: BiliSubtitleBody, ownerKey: string) {
    if (ownerKey && ownerKey !== state.videoKey) { log('drop stale track', lan, ownerKey); return; }
    const lines = (body.body || []).filter(
      (l) => l.content && l.content.trim() && !/^[♪♫\s－—\-~]*$/.test(l.content.trim()),
    );
    if (!lines.length) return;
    // classify by CONTENT, not by the lan tag: tracks whose label and script
    // disagree otherwise poison the English line with Chinese text
    let cjk = 0;
    let chars = 0;
    for (const l of lines) {
      chars += l.content.length;
      for (let i = 0; i < l.content.length; i++) {
        const c = l.content.charCodeAt(i);
        if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) cjk++;
      }
    }
    chars = chars || 1;
    const isZh = cjk / chars > 0.15;
    log(`track ${lan || '(untagged)'}: ${lines.length} lines -> ${isZh ? 'zh' : 'en'} (${Math.round((cjk / chars) * 100)}% CJK)`);
    const sents = linesToSentences(lines, isZh ? { maxChars: 25, maxGap: 0.8 } : { maxChars: 90 });
    if (isZh) {
      if (!state.zhSents?.length) { state.zhSents = sents; state.zhKey = state.videoKey; }
    } else {
      state.enSents = sents;
      state.enKey = state.videoKey;
    }
    rebuildSegments();
    if (!state.enSents?.length) maybeStartAsr();
  }

  function rebuildSegments() {
    const en = state.enKey === state.videoKey ? state.enSents || [] : [];
    const zh = state.zhKey === state.videoKey ? state.zhSents || [] : [];
    let merged: Sentence[] = [];
    if (en.length && zh.length) merged = mergeBilingual(en, zh);
    else if (en.length) merged = en;
    else if (zh.length) merged = zh;
    state.segments = merged;
    state.idx = -1;
    state.lastRender = -2;
    log(`segments ready: ${merged.length}`);
    refreshRail();
    maybeMt(merged);
  }

  // no ai-zh track -> machine-translate the EN sentences via sidecar
  let mtBusy = false;
  async function maybeMt(segs: Sentence[]) {
    if (mtBusy || !segs.length || state.zhSents?.length) return;
    const need = segs.filter((s) => s.en && !s.zh);
    if (need.length < 3) return;
    if (!(state.sidecarUp ?? (await probeSidecar()))) return;
    mtBusy = true;
    try {
      for (let i = 0; i < need.length; i += 40) {
        const batch = need.slice(i, i + 40);
        const res = await fetch('http://127.0.0.1:48211/v1/mt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ texts: batch.map((s) => s.en), from: 'en', to: 'zh-CN' }),
          signal: AbortSignal.timeout(30000),
        });
        const j = await res.json();
        if (j.aligned) batch.forEach((s, k) => { s.zh = j.results[k]; });
        else { log('mt misaligned, skipping batch'); break; }
      }
      log('mt done');
      rebuildSegments();
    } catch (e: any) {
      log('mt failed:', e.message);
    } finally {
      mtBusy = false;
    }
  }

  // ---------- ASR via local sidecar ----------
  async function probeSidecar(): Promise<boolean> {
    try {
      const r = await fetch('http://127.0.0.1:48211/v1/health', { signal: AbortSignal.timeout(1200) });
      state.sidecarUp = r.ok;
    } catch { state.sidecarUp = false; }
    return state.sidecarUp;
  }

  async function maybeStartAsr() {
    if (!state.audioUrl || state.asrPending) return;
    if (state.enKey === state.videoKey && state.enSents?.length) return; // already have EN for this video
    if (!state.videoKey || state.audioKey !== state.videoKey) { log('audio url not owned by current video, skip ASR'); return; }
    await probeSidecar();
    if (!state.sidecarUp) { log('sidecar down; ASR unavailable'); refreshRail(); return; }
    const key = state.videoKey;
    state.asrPending = true;
    refreshRail();
    try {
      const res = await fetch('http://127.0.0.1:48211/v1/asr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key,
          audio_url: state.audioUrl,
          referer: 'https://www.bilibili.com',
          lang: 'en',
        }),
        signal: AbortSignal.timeout(15000),
      });
      const job = await res.json();
      log('ASR job:', job.job_id, job.status);
      await pollAsr(job.job_id, 2400, key);
    } catch (e: any) {
      log('ASR submit failed:', e.message);
      if (key === state.videoKey) { state.asrPending = false; refreshRail(); }
    }
  }

  async function pollAsr(jobId: string, tries = 2400, ownerKey = '') {
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      if (ownerKey && ownerKey !== state.videoKey) { log('drop ASR for', ownerKey); return; }
      try {
        const j = await (await fetch(`http://127.0.0.1:48211/v1/jobs/${jobId}`)).json();
        if (typeof j.progress === 'number') { state.asrPct = j.progress; refreshRail(); }
        if (j.status === 'superseded') { log('ASR superseded'); if (!ownerKey || ownerKey === state.videoKey) { state.asrPending = false; refreshRail(); } return; }
        if (j.status === 'done') {
          const all = asrToSentences(j.result.segments);
          // A Chinese-narrated lesson that reads English examples is the common
          // case here: keep the Latin sentences, drop the Chinese ones.
          const en = all.filter((s) => cjkRatio(s.en || '') < 0.15);
          const dropped = all.length - en.length;
          if (!en.length) {
            state.enNote = `语音检测为 ${j.result.detected_lang || '非英文'}，本片没有英文句可提取`;
            log('ASR produced no English:', all.length, 'segments');
          } else {
            state.enNote = dropped ? `英文句 ${en.length} 条（跳过 ${dropped} 条中文讲解）` : '';
            state.enSents = en;
            state.enKey = ownerKey || state.videoKey;
          }
          state.asrPending = false;
          state.asrPct = 0;
          rebuildSegments();
          log('ASR done:', en.length, 'of', all.length, 'sentences usable');
          return;
        }
        if (j.status === 'error') {
          state.asrPending = false;
          state.asrPct = 0;
          state.enNote = `转写失败：${(j.error || '未知错误').slice(0, 60)}`;
          log('ASR error:', j.error);
          refreshRail();
          return;
        }
        if (j.status === 'superseded') return;
      } catch (e: any) {
        log('ASR poll fail:', e.message);
      }
    }
  }

  // ---------- sniffing ----------
  const origFetch = W.fetch.bind(W);
  W.fetch = async (...args: any[]) => {
    const res = await origFetch(...args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (/\/x\/player\/(wbi\/)?v2/.test(url)) {
        res.clone().json().then((j: any) => onPlayerV2(j, url)).catch(() => {});
      } else if (/\/x\/player\/(wbi\/)?playurl/.test(url)) {
        res.clone().json().then(onPlayurl).catch(() => {});
      }
    } catch { /* never break the player */ }
    return res;
  };
  const OrigXHR = W.XMLHttpRequest;
  function PatchedXHR(this: any) {
    const xhr = new OrigXHR();
    let url = '';
    const origOpen = xhr.open;
    xhr.open = function (...a: any[]) {
      url = String(a[1] || '');
      return origOpen.apply(xhr, a);
    };
    xhr.addEventListener('load', () => {
      try {
        if (/\/x\/player\/(wbi\/)?v2/.test(url)) onPlayerV2(JSON.parse(xhr.responseText), url);
        else if (/\/x\/player\/(wbi\/)?playurl/.test(url)) onPlayurl(JSON.parse(xhr.responseText));
      } catch { /* ignore */ }
    });
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  // static props (UNSENT etc.)
  for (const k of Object.getOwnPropertyNames(OrigXHR)) {
    try { (PatchedXHR as any)[k] = (OrigXHR as any)[k]; } catch { /* ignore */ }
  }
  W.XMLHttpRequest = PatchedXHR;
  log('sniffer installed');

  // ---------- overlay ----------
  let host: HTMLDivElement | null = null;
  let shadow: ShadowRoot | null = null;
  let elEn: HTMLDivElement, elZh: HTMLDivElement, elRail: HTMLDivElement, elStatus: HTMLSpanElement;

  const CSS = `
    :host { all: initial; }
    .root { position:absolute; left:0; right:0; bottom:var(--eb,13%); display:flex; flex-direction:column;
            align-items:center; gap:6px; pointer-events:none; font-family:"Segoe UI","Microsoft YaHei",sans-serif; }
    .en { font-size:var(--ef,26px); line-height:1.35; color:#fff; text-align:center; max-width:86%;
          text-shadow:0 1px 4px rgba(0,0,0,.9),0 0 2px rgba(0,0,0,.8); cursor:pointer; }
    .en span.w { border-radius:4px; padding:0 1px; }
    .en span.w:hover { background:rgba(64,158,255,.45); }
    .en .hi { color:#7cc4ff; }
    .zh { font-size:calc(var(--ef,26px) * .73); line-height:1.4; color:rgba(255,255,255,.92); text-align:center; max-width:86%;
          text-shadow:0 1px 4px rgba(0,0,0,.9); }
    .blind .en, .blind .zh { visibility:hidden; }
    .r1 .zh { visibility:hidden; }
    .rail { pointer-events:auto; display:flex; gap:6px; align-items:center; margin-top:2px;
            background:rgba(20,20,28,.72); border-radius:8px; padding:4px 8px;
            opacity:0; transition:opacity .18s; }
    .root:hover .rail { opacity:1; }
    .rail button { all:unset; cursor:pointer; color:#ddd; font-size:12px; padding:3px 9px; border-radius:5px; }
    .rail button:hover { background:rgba(255,255,255,.14); color:#fff; }
    .rail button.on { color:#409eff; font-weight:600; }
    .rail .status { color:#9aa; font-size:11px; margin-left:4px; }
    .rail button.accent { color:#ffd04d; }
  `;

  function ensureOverlay() {
    const video = document.querySelector('video');
    if (!video) return false;
    if (host && host.isConnected && state.video === video) return true;
    const container = video.closest('.bpx-player-container') || video.parentElement || document.body;
    host = document.createElement('div');
    host.id = 'ears-host';
    host.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2147483000;';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    const root = document.createElement('div');
    root.className = 'root';
    elEn = document.createElement('div');
    elEn.className = 'en';
    elZh = document.createElement('div');
    elZh.className = 'zh';
    elRail = document.createElement('div');
    elRail.className = 'rail';
    elStatus = document.createElement('span');
    elStatus.className = 'status';
    elRail.append(...railButtons(), elStatus);
    root.append(elEn, elZh, elRail);
    shadow.appendChild(root);
    (container as HTMLElement).style.position ||= 'relative';
    container.appendChild(host);
    state.video = video;
    state.idx = -1;
    state.lastRender = -2;
    video.addEventListener('seeked', () => { state.lastRender = -2; state.justSeeked = true; render(true); });
    applyLayout();
    log('overlay attached to', (container as HTMLElement).className?.slice?.(0, 40));
    startLoop();
    return true;
  }

  function railButtons(): HTMLElement[] {
    const mk = (label: string, title: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', onClick);
      return b;
    };
    return [
      mk('总', '总开关 Alt+S', () => setSettings({ enabled: !state.enabled })),
      mk('EN', '英文字幕 Alt+E', () => setSettings({ showEn: !state.showEn })),
      mk('ZH', '中文字幕 Alt+C', () => setSettings({ showZh: !state.showZh })),
      mk('精听', '精听模式 Alt+I', () => setSettings({ intensive: !state.intensive })),
      mk('◀ 句', '上一句 [', () => doPrev()),
      mk('句 ▶', '下一句 ]', () => doNext()),
    ];
  }

  function applyLayout() {
    if (!shadow) return;
    const root = shadow.querySelector('.root') as HTMLElement;
    root.style.setProperty('--eb', `${state.bottomPct}%`);
    root.style.setProperty('--ef', `${state.fontSize}px`);
  }

  function setSettings(patch: Partial<typeof state>) {
    Object.assign(state, patch);
    if (patch.intensive !== undefined) { state.reveal = 0; state.pausedThisSentence = false; state.loopsDone = 0; }
    persist();
    document.documentElement.classList.toggle('ears-hide-native', state.enabled && state.showZh);
    applyLayout();
    render(true);
    refreshRail();
  }

  function refreshRail() {
    if (!shadow) return;
    const btns = elRail.querySelectorAll('button');
    btns[0].classList.toggle('on', state.enabled);
    btns[1].classList.toggle('on', state.showEn);
    btns[2].classList.toggle('on', state.showZh);
    btns[3].classList.toggle('on', state.intensive);
    const n = state.segments.length;
    const hasEn = !!state.enSents?.length;
    let s = n ? `${state.idx + 1}/${n}` : '';
    if (state.asrPending) s = state.asrPct > 0 ? `英文转写中 ${Math.round(state.asrPct * 100)}%` : '排队转写英文…';
    else if (state.enNote && !hasEn) s = state.enNote;
    else if (!n) s = state.sidecarUp === false && !state.zhSents?.length ? '无字幕(可装sidecar转写)' : '等待字幕数据…';
    elStatus.textContent = s;
  }

  // ---------- render ----------
  function render(force = false) {
    if (!shadow || !state.video) return;
    if (!state.enabled) { (shadow.querySelector('.root') as HTMLElement).style.display = 'none'; return; }
    (shadow.querySelector('.root') as HTMLElement).style.display = '';
    const t = state.video.currentTime - state.offsetMs / 1000;
    let idx = findAt(state.segments, t);
    if (idx !== state.idx) {
      // intensive: if playback crossed a sentence boundary without the
      // end-of-sentence pause firing (contiguous sentences), stop at the
      // boundary and keep displaying the sentence just finished
      const prevIdx = state.idx;
      if (
        state.intensive && prevIdx >= 0 && state.segments[prevIdx] &&
        !state.pausedThisSentence && !state.video.paused &&
        t >= state.segments[prevIdx].end - 0.06
      ) {
        state.video.pause();
        state.video.currentTime = Math.max(state.segments[prevIdx].start, state.segments[prevIdx].end - 0.05);
        state.pausedThisSentence = true;
        state.loopsDone += 1;
        idx = prevIdx;
      }
      state.idx = idx;
      state.lastRender = -2;
      // sync instrumentation: >0 means we showed the line late (ms);
      // the first flip after a seek reflects seek/rebuffer, not sync
      if (state.segments[idx]) {
        state.flipDeltaMs = Math.round((t - state.segments[idx].start) * 1000);
        if (!state.justSeeked) {
          state.flipLog.push(state.flipDeltaMs);
          if (state.flipLog.length > 600) state.flipLog.shift();
        }
        state.justSeeked = false;
      }
      if (state.intensive && !(state.pausedThisSentence && idx === prevIdx)) {
        state.reveal = 0; state.pausedThisSentence = false; state.loopsDone = 0;
      }
    }
    if (!force && idx === state.lastRender) return;
    state.lastRender = idx;

    const seg = idx >= 0 ? state.segments[idx] : null;
    const root = shadow.querySelector('.root') as HTMLElement;
    root.classList.toggle('blind', state.intensive && state.reveal === 0);
    root.classList.toggle('r1', state.intensive && state.reveal === 1);

    if (seg?.en) {
      elEn.innerHTML = '';
      const words = seg.words?.length ? seg.words.map((w) => w.t) : (seg.en.match(/\S+/g) || []);
      for (const w of words) {
        const sp = document.createElement('span');
        sp.className = 'w';
        sp.textContent = w + ' ';
        sp.addEventListener('click', (ev) => { ev.stopPropagation(); onWordClick(w, seg); });
        elEn.appendChild(sp);
      }
    } else elEn.textContent = seg?.zh ? '' : '';
    elZh.textContent = seg?.zh || '';

    // hide lines by toggle
    elEn.style.display = state.showEn && seg?.en ? '' : 'none';
    elZh.style.display = state.showZh && seg?.zh ? '' : 'none';
    refreshRail();
  }

  // ---------- intensive listening ----------
  function intensiveTick() {
    const v = state.video;
    if (!v || !state.intensive || !state.segments.length || state.idx < 0) return;
    const seg = state.segments[state.idx];
    if (!state.pausedThisSentence && v.currentTime >= seg.end - 0.06 && !v.paused) {
      v.pause();
      state.pausedThisSentence = true;
      state.loopsDone += 1;
      render(true);
    }
  }

  function advanceReveal() {
    if (!state.intensive) return;
    const seg = state.segments[state.idx];
    if (state.reveal < 2) {
      state.reveal += 1;
      render(true);
      return;
    }
    // fully revealed: replay or move on
    const v = state.video!;
    if (state.loopsDone < state.loopCount) {
      v.currentTime = seg.start + 0.02;
      state.reveal = 0;
      state.pausedThisSentence = false;
      render(true);
      v.play().catch(() => {});
      return;
    }
    const next = state.idx + 1;
    if (next < state.segments.length) {
      v.currentTime = state.segments[next].start + 0.02;
      v.play().catch(() => {});
    }
  }

  // ---------- navigation ----------
  function doPrev() {
    if (!state.video || !state.segments.length) return;
    const r = prevSentence(state.segments, state.idx, state.video.currentTime);
    if (r.seekTo != null) {
      state.video.currentTime = r.seekTo;
      state.idx = r.index;
      state.lastRender = -2;
      if (state.intensive) { state.reveal = 0; state.pausedThisSentence = false; state.loopsDone = 0; }
      render(true);
    }
  }
  function doNext() {
    if (!state.video || !state.segments.length) return;
    const r = nextSentence(state.segments, state.idx, state.video.currentTime);
    if (r.seekTo != null) {
      state.video.currentTime = r.seekTo;
      state.idx = r.index;
      state.lastRender = -2;
      if (state.intensive) { state.reveal = 0; state.pausedThisSentence = false; state.loopsDone = 0; }
      render(true);
    }
  }

  async function onWordClick(word: string, seg: Sentence) {
    const clean = word.replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, '');
    if (!clean) return;
    let tip = '';
    try {
      if (state.sidecarUp ?? (await probeSidecar())) {
        const r = await fetch(`http://127.0.0.1:48211/v1/dict?word=${encodeURIComponent(clean)}`,
          { signal: AbortSignal.timeout(3000) });
        const j = await r.json();
        tip = `${j.word || clean}  ${j.phonetic || ''}\n${((j.pos ? j.pos + '. ' : '') + (j.translation || '无释义')).slice(0, 200)}`;
      }
    } catch { /* fall through */ }
    if (!tip) tip = `${clean}（sidecar 未启动，无法查词）`;
    elZh.textContent = `📖 ${tip}`;
    elZh.style.display = '';
    clearTimeout((onWordClick as any)._t);
    (onWordClick as any)._t = setTimeout(() => render(true), 4000);
  }

  // ---------- keyboard ----------
  const onKeydown = (e: KeyboardEvent) => {
    const tgt = e.target as HTMLElement;
    if (tgt?.closest?.('input,textarea,[contenteditable]') || tgt?.isContentEditable) return;
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'e') { setSettings({ showEn: !state.showEn }); e.preventDefault(); e.stopPropagation(); }
      else if (k === 'c') { setSettings({ showZh: !state.showZh }); e.preventDefault(); e.stopPropagation(); }
      else if (k === 's') { setSettings({ enabled: !state.enabled }); e.preventDefault(); e.stopPropagation(); }
      else if (k === 'i') { setSettings({ intensive: !state.intensive }); e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (e.key === '[') { doPrev(); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === ']') { doNext(); e.preventDefault(); e.stopPropagation(); }
    else if (state.intensive && (e.key === 'ArrowRight' || e.key === 'Enter')) {
      advanceReveal(); e.preventDefault(); e.stopPropagation();
    }
  };
  document.addEventListener('keydown', onKeydown, true);
  disposables.push(() => document.removeEventListener('keydown', onKeydown, true));

  // native subtitle hiding — documentElement is null at document-start in the
  // client's player window, so defer until the DOM actually exists
  const initDom = () => {
    const nativeStyle = document.createElement('style');
    nativeStyle.textContent = 'html.ears-hide-native .bpx-player-subtitle-wrap{display:none!important}';
    document.documentElement.appendChild(nativeStyle);
    document.documentElement.classList.toggle('ears-hide-native', state.enabled && state.showZh);
    const mo = new MutationObserver(() => {
      const v = document.querySelector('video');
      if (v && v !== state.video) { log('video element changed, re-binding'); ensureOverlay(); }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    disposables.push(() => { mo.disconnect(); nativeStyle.remove(); document.documentElement.classList.remove('ears-hide-native'); });
  };
  if (document.documentElement) initDom();
  else document.addEventListener('DOMContentLoaded', initDom, { once: true });

  // watch for video element (re)creation: new video, P switch, window reload
  const bindTimer = setInterval(() => { if (!ensureOverlay()) return; clearInterval(bindTimer); }, 500);
  disposables.push(() => clearInterval(bindTimer));
  let loopRunning = false;
  let lastVfcAt = 0; // 0 = vfc never fired; watchdog must still work then
  function startLoop() {
    if (loopRunning || !state.video) return;
    loopRunning = true;
    const v = state.video;
    const tickVfc = () => {
      if (!v.isConnected) { loopRunning = false; return; }
      lastVfcAt = performance.now();
      render(false);
      intensiveTick();
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tickVfc);
      else requestAnimationFrame(tickVfc);
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tickVfc);
    else requestAnimationFrame(tickVfc);
    // watchdog: when the window is occluded, frames stop being presented and
    // vfc stalls; keep rendering from a timer so subtitles never freeze
    const watchdog = setInterval(() => {
      // render even while paused: users stop the video to read a sentence, and
      // an occluded window never presents frames for vfc to wake us up
      if (loopRunning && performance.now() - lastVfcAt > 300) {
        render(false);
        if (!v.paused) intensiveTick();
      }
    }, 80);
    disposables.push(() => { clearInterval(watchdog); loopRunning = false; });
  }

  // re-probe sidecar occasionally so the word click works after late start
  const probeTimer = setInterval(() => probeSidecar().then(refreshRail), 20000);
  disposables.push(() => clearInterval(probeTimer));

  // backstop: if the player window finished loading before we were injected
  // (client's own startup video), we sniffed nothing -> reload once so the
  // document-start patch catches the player's API responses
  const initWatch = setInterval(() => {
    if (state.videoKey) { clearInterval(initWatch); return; }
    if (document.readyState !== 'complete') return;
    if ((W.__earsReloaded || sessionStorage.getItem('ears.reloaded')) && Date.now() - startedAt < 25000) return;
    if (Date.now() - startedAt < 10000) return;
    W.__earsReloaded = 1;
    try { sessionStorage.setItem('ears.reloaded', '1'); } catch { /* ignore */ }
    log('no player API seen, reloading once to catch it');
    clearInterval(initWatch);
    location.reload();
  }, 1500);
  disposables.push(() => clearInterval(initWatch));

  // teardown so a newer bundle can replace this instance cleanly
  W.__ears.teardown = () => {
    for (const d of disposables.splice(0)) { try { d(); } catch {} }
    document.getElementById('ears-host')?.remove();
  };

  // test hooks
  Object.assign(W.__ears, {
    state,
    doPrev,
    doNext,
    setSettings,
    findAt,
  });

  // live-apply settings changed from the management panel (other window)
  W.addEventListener('storage', (e: StorageEvent) => {
    if (e.key !== 'ears.settings') return;
    try {
      Object.assign(state, JSON.parse(e.newValue || '{}'));
      state.reveal = 0;
      applyLayout();
      render(true);
      refreshRail();
    } catch { /* ignore */ }
  });

  if (!/player\.html/.test(location.pathname)) {
    installPanel(persist);
  }

  log('ears bundle loaded v5');
})();
