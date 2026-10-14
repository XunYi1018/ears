"""Ears sidecar — local ASR (faster-whisper) + offline dict for the Bilibili client overlay.

Binds 127.0.0.1 only. Endpoints:
  GET  /v1/health
  POST /v1/asr        {key, audio_url, referer, lang} -> {job_id, status}
  GET  /v1/jobs/{id}  -> {status, progress, result, error}
  GET  /v1/dict?word= -> P3 (ECDICT) — returns not_ready until built
"""
from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from .engine.whisper_engine import WhisperEngine
from .pipeline.download import download_audio

logging.basicConfig(level=logging.INFO, format="[ears-sidecar] %(levelname)s %(message)s")
log = logging.getLogger("ears")

PORT = 48211
DATA_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Ears"
CACHE_ASR = DATA_DIR / "cache" / "asr"
CACHE_AUDIO = DATA_DIR / "cache" / "audio"
for d in (CACHE_ASR, CACHE_AUDIO):
    d.mkdir(parents=True, exist_ok=True)

ALLOWED_ORIGIN = re.compile(r"^https://([a-z0-9.-]*\.)?bilibili\.com$")

app = FastAPI()
engine = WhisperEngine("small", CACHE_ASR.parent)
executor = ThreadPoolExecutor(max_workers=1)
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()


def local_guard(request: Request) -> None:
    if request.client and request.client.host not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(403, "local only")
    origin = request.headers.get("origin", "")
    if origin and not ALLOWED_ORIGIN.match(origin):
        raise HTTPException(403, "origin not allowed")


@app.get("/v1/health", dependencies=[Depends(local_guard)])
def health():
    return {"ok": True, "model_loaded": engine.loaded, "pipeline": 1}


@app.post("/v1/asr", dependencies=[Depends(local_guard)])
async def start_asr(req: Request):
    body = await req.json()
    key = str(body.get("key", ""))[:120]
    audio_url = body.get("audio_url", "")
    referer = body.get("referer", "https://www.bilibili.com")
    lang = body.get("lang", "auto")
    if not key.strip(':') or not audio_url.startswith("http"):
        raise HTTPException(400, "key must be aid:cid and audio_url required")

    # disk cache hit -> hand back a finished job
    cached = CACHE_ASR / f"{_safe(key)}.json"
    if cached.exists():
        try:
            result = json.loads(cached.read_text("utf-8"))
            jid = _new_job("done", progress=1.0)
            jobs[jid]["result"] = result
            return {"job_id": jid, "status": "done", "cached": True}
        except Exception:
            cached.unlink(missing_ok=True)

    # a job that has not started yet is superseded by the video being watched now
    with jobs_lock:
        for oid, o in jobs.items():
            if o["status"] == "queued":
                o["status"] = "superseded"
                o["error"] = "replaced by a newer request"
    jid = _new_job("queued")
    executor.submit(_run_asr, jid, key, audio_url, referer, lang)
    return {"job_id": jid, "status": "queued"}


@app.get("/v1/jobs/{jid}", dependencies=[Depends(local_guard)])
def job_status(jid: str):
    with jobs_lock:
        job = jobs.get(jid)
        if not job:
            raise HTTPException(404, "no such job")
        return {k: v for k, v in job.items() if k != "cancel"}


DICT_DB = Path(__file__).resolve().parents[3] / "data" / "ecdict" / "ears_dict.db"
_dict_conn: sqlite3.Connection | None = None


def _dict() -> sqlite3.Connection:
    global _dict_conn
    if _dict_conn is None:
        _dict_conn = sqlite3.connect(f"file:{DICT_DB.as_posix()}?mode=ro", uri=True, check_same_thread=False)
    return _dict_conn


def lookup_word(word: str) -> dict | None:
    w = word.lower().strip()
    row = _dict().execute(
        "SELECT word, phonetic, translation, pos, bnc, frq FROM dict WHERE word=?", (w,)
    ).fetchone()
    if not row:
        bases = [r[0] for r in _dict().execute(
            "SELECT base FROM lemma WHERE inflected=?", (w,)
        ).fetchall()]
        # prefer a base that is itself in the dict (guards against lemma-list noise like was->wa)
        for b in bases:
            row = _dict().execute(
                "SELECT word, phonetic, translation, pos, bnc, frq FROM dict WHERE word=?", (b,)
            ).fetchone()
            if row:
                break
    if not row:
        return None
    return {"word": row[0], "phonetic": row[1] or "", "translation": row[2],
            "pos": row[3] or "", "bnc": row[4], "frq": row[5]}


@app.post("/v1/mt", dependencies=[Depends(local_guard)])
async def mt(req: Request):
    body = await req.json()
    texts = body.get("texts") or []
    src = body.get("from", "en")
    to = body.get("to", "zh-CN")
    if not texts:
        return {"results": []}
    joined = "\n".join(t.replace("\n", " ") for t in texts)
    async with httpx.AsyncClient(timeout=20, trust_env=True) as cli:
        r = await cli.get("https://clients5.google.com/translate_a/t",
                          params={"client": "dict-chrome-ex", "sl": src, "tl": to, "q": joined},
                          headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/108.0.0.0"})
        if r.status_code != 200:
            raise HTTPException(502, f"mt upstream {r.status_code}")
        data = r.json()
    # response is a list whose first element is the translated block with \n kept
    para = data[0] if isinstance(data, list) and isinstance(data[0], str) else str(data)
    lines = para.split("\n")
    results = lines if len(lines) == len(texts) else [para]
    return {"results": results, "aligned": len(results) == len(texts)}


@app.get("/v1/dict", dependencies=[Depends(local_guard)])
def dict_lookup(word: str):
    r = lookup_word(word)
    if not r:
        raise HTTPException(404, "not found")
    return r


@app.get("/v1/cache", dependencies=[Depends(local_guard)])
def cache_list():
    items = []
    for f in sorted(CACHE_ASR.glob("*.json")):
        try:
            d = json.loads(f.read_text("utf-8"))
            items.append({"key": d.get("key", f.stem), "segs": len(d.get("segments", [])),
                          "bytes": f.stat().st_size, "model": d.get("model", "")})
        except Exception:
            items.append({"key": f.stem, "segs": 0, "bytes": f.stat().st_size, "model": "?"})
    return {"items": items, "total": sum(i["bytes"] for i in items)}


@app.delete("/v1/cache", dependencies=[Depends(local_guard)])
def cache_clear(key: str | None = None):
    removed = 0
    targets = [CACHE_ASR / f"{_safe(key)}.json"] if key else list(CACHE_ASR.glob("*.json"))
    for f in targets:
        if f.exists():
            f.unlink()
            removed += 1
    for f in CACHE_AUDIO.glob("*"):
        f.unlink()
        removed += 1
    return {"removed": removed}


# ---------- internals ----------

def _safe(key: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", key)


def _new_job(status: str, progress: float = 0.0) -> str:
    jid = uuid.uuid4().hex[:12]
    with jobs_lock:
        jobs[jid] = {"status": status, "progress": progress, "result": None, "error": None}
    # keep the dict bounded
    if len(jobs) > 200:
        for old in [k for k, v in jobs.items() if v["status"] in ("done", "error")][:100]:
            jobs.pop(old, None)
    return jid


def _run_asr(jid: str, key: str, audio_url: str, referer: str, lang: str) -> None:
    def setp(status: str, progress: float = None, **kw):
        with jobs_lock:
            jobs[jid]["status"] = status
            if progress is not None:
                jobs[jid]["progress"] = round(progress, 3)
            jobs[jid].update(kw)

    with jobs_lock:
        if jobs[jid]["status"] == "superseded":
            return
    try:
        audio_path = CACHE_AUDIO / f"{_safe(key)}.m4s"
        if not audio_path.exists():
            setp("downloading", 0.02)
            download_audio(audio_url, referer, audio_path)
        setp("loading_model", 0.1)
        engine.ensure_loaded(setp)
        setp("transcribing", 0.2)
        segments, detected, prob = engine.transcribe(str(audio_path), lang, lambda p: setp("transcribing", 0.2 + 0.8 * p))
        result = {"v": 1, "key": key, "src": "asr", "lang": lang, "requested_lang": lang,
                  "detected_lang": detected, "detected_prob": prob,
                  "model": engine.tag, "segments": segments}
        (CACHE_ASR / f"{_safe(key)}.json").write_text(
            json.dumps(result, ensure_ascii=False), "utf-8")
        audio_path.unlink(missing_ok=True)
        setp("done", 1.0)
        jobs[jid]["result"] = result
        log.info("asr done: %s -> %d segments", key, len(segments))
    except Exception as e:  # noqa: BLE001 — report to client via job status
        log.exception("asr failed for %s", key)
        setp("error", error=str(e)[:500])
