// Management panel injected into the Bilibili client's own sidebar/settings area.
// Runs in the main window (index.html); the player windows pick up changes through
// the localStorage 'storage' event, which is same-origin across Electron windows.


const SIDEBAR = 'UL.app_sidebar--settings';
const STYLE = `
:host { all: initial; }
.entry { display:flex; align-items:center; gap:8px; cursor:pointer; color:var(--text3,#9499a0); }
.entry.on { color:#fb7299; }
.entry .ico { font-size:17px; line-height:1; }
.entry .txt { font-size:13px; }
.mask { position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:2147483000; display:flex; align-items:center; justify-content:center; }
.card { width:520px; max-height:82vh; overflow:auto; background:#fff; color:#18191c; border-radius:12px; padding:20px 22px; font:13px/1.6 "Microsoft YaHei",sans-serif; box-shadow:0 12px 48px rgba(0,0,0,.3); }
.card.dark { background:#17181a; color:#e8eaf0; }
h3 { margin:0 0 4px; font-size:17px; }
.sub { opacity:.6; margin-bottom:14px; }
.row { display:flex; align-items:center; justify-content:space-between; padding:9px 0; border-top:1px solid rgba(128,128,128,.18); gap:12px; }
.row label { flex:1; }
.hint { font-size:11px; opacity:.55; }
.sw { width:40px; height:22px; border-radius:11px; background:#c9ccd0; position:relative; cursor:pointer; flex:none; transition:background .15s; }
.sw.on { background:#fb7299; }
.sw i { position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff; transition:left .15s; }
.sw.on i { left:21px; }
select, input[type=range] { accent-color:#fb7299; }
select { padding:3px 6px; border-radius:6px; }
button { padding:6px 12px; border-radius:6px; border:1px solid rgba(128,128,128,.35); background:transparent; color:inherit; cursor:pointer; }
button:hover { border-color:#fb7299; color:#fb7299; }
.st { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; background:#999; }
.st.ok { background:#23b96f; }
.st.bad { background:#e34d59; }
.kbd { font-family:Consolas,monospace; background:rgba(128,128,128,.16); border-radius:4px; padding:1px 5px; }
.foot { display:flex; justify-content:flex-end; gap:8px; margin-top:16px; }
.grid { display:grid; grid-template-columns:repeat(2,1fr); gap:2px 14px; font-size:12px; }
`;

type Settings = {
  enabled: boolean; showEn: boolean; showZh: boolean; intensive: boolean;
  loopCount: number; bottomPct: number; offsetMs: number; fontSize: number;
};

const DEFAULTS: Settings = {
  enabled: true, showEn: true, showZh: true, intensive: false,
  loopCount: 1, bottomPct: 13, offsetMs: 0, fontSize: 26,
};

export function installPanel(save: () => void) {
  let host = document.getElementById('ears-panel-host');

  const read = (): Settings => ({ ...DEFAULTS, ...JSON.parse(localStorage.getItem('ears.settings') || '{}') });
  const write = (patch: Partial<Settings>) => {
    const next = { ...read(), ...patch };
    localStorage.setItem('ears.settings', JSON.stringify(next));
    try { save(); } catch { /* player-window copy */ }
    render(next);
  };

  const open = () => {
    ensureStyle();
    const mask = document.createElement('div');
    mask.className = 'mask';
    mask.innerHTML = `
      <div class="card${document.documentElement.classList.contains('bili-dark') ? ' dark' : ''}">
        <h3>精听字幕 Ears</h3>
        <div class="sub">挂在客户端播放器上的英语精听层 · 改动即时生效</div>
        <div data-slot="toggles"></div>
        <div class="row"><label>精听循环次数</label><select data-k="loopCount">
          <option value="1">1 遍</option><option value="3">3 遍</option><option value="9999">无限</option></select></div>
        <div class="row"><label>字幕垂直位置 <span class="hint" data-v="bottomPct"></span></label>
          <input type="range" data-k="bottomPct" min="4" max="60" step="1"></div>
        <div class="row"><label>英文字号 <span class="hint" data-v="fontSize"></span></label>
          <input type="range" data-k="fontSize" min="16" max="44" step="1"></div>
        <div class="row"><label>字幕时间微调 <span class="hint" data-v="offsetMs"></span></label>
          <span><button data-step="-100">−100ms</button> <button data-step="100">+100ms</button></span></div>
        <div data-slot="status"></div>
        <div class="row"><label>快捷键</label>
          <div class="grid">
            <span><b class="kbd">[</b> <b class="kbd">]</b> 上/下一句</span>
            <span><b class="kbd">Alt+S</b> 总开关</span>
            <span><b class="kbd">Alt+E</b> 英文</span>
            <span><b class="kbd">Alt+C</b> 中文</span>
            <span><b class="kbd">Alt+I</b> 精听</span>
            <span><b class="kbd">→</b> 精听下一步</span>
          </div></div>
        <div class="foot"><button data-act="close">关闭</button></div>
      </div>`;
    const s = read();
    const toggles = mask.querySelector('[data-slot=toggles]')!;
    for (const [k, label] of [['enabled', '启用字幕层'], ['showEn', '显示英文'], ['showZh', '显示中文'], ['intensive', '进入精听模式']] as const) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<label>${label}</label><div class="sw${s[k] ? ' on' : ''}" data-k="${k}"><i></i></div>`;
      toggles.appendChild(row);
    }
    (mask.querySelector('[data-k=loopCount]') as HTMLSelectElement).value = String(Math.min(s.loopCount, 9999));
    (mask.querySelector('[data-k=bottomPct]') as HTMLInputElement).value = String(s.bottomPct);
    (mask.querySelector('[data-k=fontSize]') as HTMLInputElement).value = String(s.fontSize);
    const paint = (v: Settings) => {
      (mask.querySelector('[data-v=bottomPct]') as HTMLElement).textContent = `${v.bottomPct}% 高`;
      (mask.querySelector('[data-v=fontSize]') as HTMLElement).textContent = `${v.fontSize}px`;
      (mask.querySelector('[data-v=offsetMs]') as HTMLElement).textContent =
        v.offsetMs ? `${v.offsetMs > 0 ? '+' : ''}${v.offsetMs}ms` : '0（未偏移）';
    };
    paint(s);

    mask.addEventListener('click', async (ev) => {
      const t = ev.target as HTMLElement;
      const k = t.dataset.k || t.closest('[data-k]')?.getAttribute('data-k');
      if (t.dataset.act === 'close' || t === mask) { mask.remove(); return; }
      if (k && ['enabled', 'showEn', 'showZh', 'intensive'].includes(k)) {
        const cur = read()[k as keyof Settings] as boolean;
        write({ [k]: !cur } as Partial<Settings>);
        (t.closest('.sw') as HTMLElement).classList.toggle('on', !cur);
      }
      if (t.dataset.step) {
        const next = Math.max(-3000, Math.min(3000, read().offsetMs + Number(t.dataset.step)));
        write({ offsetMs: next });
        paint(read());
      }
    });
    mask.addEventListener('change', (ev) => {
      const t = ev.target as HTMLElement;
      const k = t.dataset.k;
      if (k === 'loopCount') { write({ loopCount: Number((t as HTMLSelectElement).value) }); }
      if (k === 'bottomPct') { write({ bottomPct: Number((t as HTMLInputElement).value) }); paint(read()); }
      if (k === 'fontSize') { write({ fontSize: Number((t as HTMLInputElement).value) }); paint(read()); }
    });

    const slot = mask.querySelector('[data-slot=status]')!;
    slot.innerHTML = `<div class="row"><label><span class="st"></span>本地转写服务</span><span class="hint">检测中…</span></label><span><button data-act="clear">清空缓存</button></span></div>`;
    refreshStatus(slot);
    slot.addEventListener('click', async (ev) => {
      const t = ev.target as HTMLElement;
      if (t.dataset.act === 'clear') {
        t.textContent = '清空中…';
        try {
          const r = await fetch('http://127.0.0.1:48211/v1/cache', { method: 'DELETE' });
          const j = await r.json();
          t.textContent = `已清 ${j.removed ?? 0} 项`;
        } catch { t.textContent = '服务未启动'; }
        setTimeout(() => { t.textContent = '清空缓存'; }, 2500);
      }
    });
    document.documentElement.appendChild(mask);
  };

  async function refreshStatus(slot: Element) {
    const dot = slot.querySelector('.st') as HTMLElement;
    const hint = slot.querySelector('.hint') as HTMLElement;
    try {
      const r = await fetch('http://127.0.0.1:48211/v1/health', { signal: AbortSignal.timeout(1500) });
      const j = await r.json();
      dot.classList.add('ok');
      let cached = 0;
      try {
        const c = await (await fetch('http://127.0.0.1:48211/v1/cache')).json();
        cached = c.items?.length ?? 0;
      } catch { /* ignore */ }
      hint.textContent = `运行中 · 模型${j.model_loaded ? '已加载' : '待加载'} · 已缓存 ${cached} 片`;
    } catch {
      dot.classList.add('bad');
      hint.textContent = '未启动（运行 ears.cmd 会自动拉起）';
    }
  }

  function render(s: Settings) {
    const e = host?.querySelector('.entry');
    if (e) e.classList.toggle('on', s.enabled);
  }

  function ensureStyle() {
    if (!host) {
      host = document.createElement('div');
      host.id = 'ears-panel-host';
      host.style.cssText = 'all:initial;position:fixed;left:-9999px;top:-9999px;';
      document.documentElement.appendChild(host);
    }
    if (!host.querySelector('style')) {
      const st = document.createElement('style');
      st.textContent = STYLE;
      host.appendChild(st);
    }
  }

  function tryInstall(): boolean {
    const nav = document.querySelector(SIDEBAR);
    if (!nav || nav.querySelector('[data-ears-entry]')) return !!nav;
    ensureStyle();
    const li = document.createElement('li');
    li.className = 'settings-item';
    li.setAttribute('data-ears-entry', '1');
    const sr = document.createElement('div');
    sr.className = 'ears-shadow';
    sr.style.cssText = 'display:flex;align-items:center;width:100%;height:100%;cursor:pointer;padding-left:14px;';
    sr.innerHTML = `<div class="entry${read().enabled ? ' on' : ''}"><span class="ico">🎧</span><span class="txt">精听</span></div>`;
    sr.addEventListener('click', open);
    li.appendChild(sr);
    nav.appendChild(li);
    return true;
  }

  const timer = setInterval(() => {
    if (tryInstall() && document.querySelector('[data-ears-entry]')) {
      // keep installed; sidebar can be recreated by the router
    }
  }, 1200);
  tryInstall();
  window.addEventListener('storage', (e) => {
    if (e.key === 'ears.settings') { try { render(read()); } catch { /* ignore */ } }
  });
  return () => clearInterval(timer);
}
