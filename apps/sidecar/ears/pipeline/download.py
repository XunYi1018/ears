"""Download DASH audio from bilivideo CDN. Requires browser-like headers or the CDN returns 403."""
from __future__ import annotations

import logging
from pathlib import Path

import httpx

log = logging.getLogger("ears")

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36"),
    "Referer": "https://www.bilibili.com/",
    "Origin": "https://www.bilibili.com",
}


def download_audio(url: str, referer: str, dest: Path, timeout: float = 120.0) -> None:
    headers = dict(HEADERS)
    if referer:
        headers["Referer"] = referer
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with httpx.Client(timeout=timeout, follow_redirects=True, headers=headers) as cli:
        with cli.stream("GET", url) as r:
            r.raise_for_status()
            total = int(r.headers.get("content-length") or 0)
            done = 0
            with open(tmp, "wb") as f:
                for chunk in r.iter_bytes(1 << 16):
                    f.write(chunk)
                    done += len(chunk)
    if total and done < total:
        raise RuntimeError(f"incomplete download {done}/{total}")
    tmp.replace(dest)
    log.info("audio cached: %s (%.1f MB)", dest.name, done / 1e6)
