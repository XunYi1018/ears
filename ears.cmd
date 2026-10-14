@echo off
rem Ears launcher: local ASR sidecar + Bilibili client started with injection enabled.
rem Everything is relative to this file's folder, so the repo can live anywhere.
setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%"

rem Your local HTTP proxy, used only to fetch the whisper model and machine translation.
if "%EARS_PROXY%"=="" set "EARS_PROXY=http://127.0.0.1:7890"
rem Bilibili's CDN is served from mainland nodes; sending it through a proxy just breaks it.
if "%EARS_NO_PROXY%"=="" set "EARS_NO_PROXY=localhost,127.0.0.1,bilivideo.com,bilivideo.cn,acgvideo.com,hdslb.com,bilibili.com,mcdn.bilivideo.cn"

curl -s -o NUL --max-time 2 http://127.0.0.1:48211/v1/health
if errorlevel 1 (
  echo [ears] starting sidecar ...
  start "ears-sidecar" /min cmd /c "set HTTPS_PROXY=%EARS_PROXY%&& set HTTP_PROXY=%EARS_PROXY%&& set NO_PROXY=%EARS_NO_PROXY%&& "%ROOT%apps\sidecar\.venv\Scripts\python.exe" "%ROOT%apps\sidecar\run.py""
  ping -n 4 127.0.0.1 >NUL
)

echo [ears] starting the client with injection — keep this window open
node apps\injector\ears.mjs
