"""faster-whisper engine wrapper. Loads small-int8 lazily; transcribes with word timestamps."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Callable

log = logging.getLogger("ears")

MODEL_REPO = {
    "small": "Systran/faster-whisper-small",
}


class WhisperEngine:
    def __init__(self, model: str, cache_dir: Path):
        self.model = model
        self.cache_dir = cache_dir
        self.tag = f"whisper-{model}-v1"
        self._m = None

    @property
    def loaded(self) -> bool:
        return self._m is not None

    def ensure_loaded(self, setp: Callable | None = None) -> None:
        if self._m is not None:
            return
        from faster_whisper import WhisperModel

        log.info("loading faster-whisper %s (int8) ...", self.model)
        if setp:
            setp("loading_model", 0.1)
        self._m = WhisperModel(
            MODEL_REPO[self.model],
            device="cpu",
            compute_type="int8",
            download_root=str(self.cache_dir / "models"),
        )
        log.info("model loaded")

    def transcribe(self, audio_path: str, lang: str, on_progress: Callable[[float], None] | None = None):
        self.ensure_loaded()
        segments, info = self._m.transcribe(
            audio_path,
            # forcing 'en' on a Chinese-narrated video makes whisper emit Chinese as
            # if it were English; auto-detect and let the caller filter instead
            language=None if (not lang or lang == "auto") else lang,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            # beam 5 -> 1 plus no cross-window conditioning: ~3x faster, which is
            # what decides whether the user waits for English lines or gets them
            beam_size=1,
            best_of=1,
            condition_on_previous_text=False,
        )
        out = []
        for seg in segments:
            words = []
            for w in (seg.words or []):
                tok = w.word.strip()
                if not tok:
                    continue
                words.append({"t": tok, "s": round(w.start, 3), "e": round(w.end, 3)})
            out.append({
                "start": round(seg.start, 3),
                "end": round(seg.end, 3),
                "text": seg.text.strip(),
                "words": words,
            })
            if on_progress and info.duration > 0:
                on_progress(min(1.0, seg.end / info.duration))
        return out, info.language, round(float(info.language_probability or 0), 2)
