# Ears — 挂在哔哩哔哩桌面客户端里的英语精听字幕层

在**已经装好的 B站桌面客户端**里直接练英语听力，不需要换播放器、不需要下载视频。

| 能力 | 操作 |
|---|---|
| 跳到上一句 / 下一句（句子级，不是 ±5 秒） | `[` `]` |
| 双语字幕：上面英文，下面中文 | 自动 |
| 分别开关英文 / 中文 / 总开关 | `Alt+E` `Alt+C` `Alt+S` |
| 点英文字幕里的单词查词典 | 鼠标点 |
| 精听模式：盲听 → 出英文 → 出中文，句末自动停 | `Alt+I`，按 `→` 逐层揭示 |
| 管理面板（字幕位置、字号、时间微调、缓存） | 客户端左侧栏 `🎧 精听` |

## 为什么字幕能"不滞后"

实时把音频转文字永远赶不上你耳朵——Whisper 是非因果模型，要攒够音频窗口才吐字。
所以这里不做实时识别：**视频一打开就在后台把整片转写+对齐好并缓存**，播放时只是按时间点亮字幕，
点亮用的是 `requestVideoFrameCallback`（跟视频自己的帧时钟），倍速、卡顿、拖动进度条都对得上。

## 数据来源

- **英文行**：本地 `faster-whisper small int8` 转写（带词级时间戳，所以能点词）。首次转写后永久缓存，再打开秒出。
- **中文行**：优先用 B站自己的 `ai-zh` 轨；没有就走机器翻译。
- **词典**：[ECDICT](https://github.com/skywind3000/ECDICT)（MIT）离线 SQLite + `lemma.en.txt` 词形还原（点 `left` 能查到 `leave`）。

## 环境要求

- Windows；B站桌面客户端 **v1.19.0**（Electron 22.3.27 / Chromium 108）——其他版本未验证。
- Node.js ≥ 22（注入器用 Node 内置 WebSocket）。
- `uv`（建 Python 虚拟环境）与 `ffmpeg`（音频解码）。
- 一个可用的 HTTP 代理：只在**首次下载 whisper 模型**和**机器翻译**时用到；B站 CDN 走直连。
  代理不是 `127.0.0.1:7890` 的话，在 `ears.cmd` 之前 `set EARS_PROXY=http://127.0.0.1:你的端口`。
  客户端不在默认位置的话 `set EARS_CLIENT=D:\你的路径\哔哩哔哩.exe`。

## 安装

```cmd
:: 1) 前端（注入器 + 字幕层）
npm install
npm run build

:: 2) 本地服务（Python 3.11：ctranslate2 4.4.0 没有 3.13 的 wheel）
uv venv apps/sidecar/.venv --python 3.11
uv pip install -p apps/sidecar/.venv/Scripts/python.exe fastapi "uvicorn[standard]" httpx "numpy<2" requests
uv pip install -p apps/sidecar/.venv/Scripts/python.exe faster-whisper==1.0.3 ctranslate2==4.4.0
uv pip install -p apps/sidecar/.venv/Scripts/python.exe "setuptools<81"

:: 3) 离线词典（约 51MB 下载，产出 11MB 的库）
cd data\ecdict
curl -L -o ecdict-sqlite.zip https://github.com/skywind3000/ECDICT/releases/download/1.0.28/ecdict-sqlite-28.zip
curl -L -o lemma.en.txt https://raw.githubusercontent.com/skywind3000/ECDICT/master/lemma.en.txt
python -c "import zipfile;zipfile.ZipFile('ecdict-sqlite.zip').extractall('.')"
cd ..\..
python apps\sidecar\ears\store\build_dict.py
```

## 启动

双击 **`ears.cmd`**（或命令行执行）。它会：

1. 拉起本地 sidecar（`127.0.0.1:48211`）；
2. **关掉正在运行的 B站客户端并带调试端口重启**（Electron 单实例锁，必须重启才能注入）；
3. 把字幕层注入到之后打开的每一个窗口。

那个黑色命令行窗口要保持开着——它一关，注入就停了。关掉播放器窗口不会停：注入器会自动等客户端回来。

## 架构

```
packages/core/        纯 TS，零 DOM 依赖：句子重切分、二分查找当前句、上下句导航
apps/injector/        交付主体
  ears.mjs            CDP 连接 + 断线重连 + 把 bundle 注入每个页面
  src/bundle/entry.ts 嗅探播放器自己的 API 响应 → 重切句 → Shadow DOM 字幕层
  src/bundle/panel.ts 客户端侧栏里的管理面板
apps/sidecar/         Python 3.11 + FastAPI，只监听 127.0.0.1
  ears/engine/        faster-whisper 封装（可替换接缝）
  ears/pipeline/      音频下载（B站 CDN 要求浏览器 UA + Referer）
  ears/store/         ECDICT 建库
recon/                前期侦察脚本（字幕轨真实性、注入通道验证）
```

### 关键设计

- **只嗅探，不重发请求**：monkey-patch `fetch`/`XHR`，截客户端**自己发出**的 `x/player/wbi/v2` 与 `playurl` 响应。自己重发要过 wbi 签名，且容易撞 412 风控。
- **每个数据集带 `aid:cid` 归属**：客户端换视频是同一文档内的 SPA 跳转，不重新加载页面。不带归属 key 的话，上一个视频的英文行会永久残留。
- **字幕轨按内容判定语言**，不信 `lan` 标签：标签和文字不一致的轨真实存在。
- **遮挡时也要渲染**：窗口被盖住时 Chromium 不再呈现帧，`requestVideoFrameCallback` 会停；用一个看门狗定时器兜底，并且暂停时也要刷新（暂停看字幕是常态）。

## 已知限制

- 只支持 B站桌面客户端，**抖音还没做**。
- 客户端大版本更新后需要重新验证注入通道。
- 若视频本身是**中文讲解**（例如"用中文讲怎么练听力"），Whisper 可能输出中文的英译而不是原话。工具会过滤掉中文句、并在控件条写明"英文句 N 条（跳过 M 条中文讲解）"，但请把它当提示而不是保证。
- 启动器会重启你的客户端窗口（已做成显式提示，不静默 kill）。

## 致谢

- [faster-whisper](https://github.com/SYSTRAN/faster-whisper)（CTranslate2 上的 Whisper 推理）
- [ECDICT](https://github.com/skywind3000/ECDICT)（MIT 开源词典）

## License

MIT
