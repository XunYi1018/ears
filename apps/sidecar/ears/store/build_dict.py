"""Build a compact offline dict DB from ECDICT's stardict.db.

Keeps common words (bnc/frq/oxford/collins ranked) + lemma.en.txt inflection map.
Output: data/ecdict/ears_dict.db with tables dict(word, phonetic, translation, pos, exchange, bnc, frq)
and lemma(inflected PRIMARY KEY, base).
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[4] / "data" / "ecdict" / "stardict.db"
DST = Path(__file__).resolve().parents[4] / "data" / "ecdict" / "ears_dict.db"
LEMMA = Path(__file__).resolve().parents[4] / "data" / "ecdict" / "lemma.en.txt"


def main() -> None:
    if DST.exists():
        DST.unlink()
    src = sqlite3.connect(f"file:{SRC.as_posix()}?mode=ro", uri=True)
    out = sqlite3.connect(DST)
    out.executescript(
        """
        CREATE TABLE dict(word TEXT PRIMARY KEY, phonetic TEXT, translation TEXT,
                          pos TEXT, exchange TEXT, bnc INT, frq INT);
        CREATE TABLE lemma(inflected TEXT PRIMARY KEY, base TEXT);
        """
    )
    cur = src.execute(
        "SELECT word, phonetic, translation, pos, exchange, bnc, frq FROM stardict "
        "WHERE translation IS NOT NULL AND translation != '' "
        "AND (bnc > 0 OR frq > 0 OR oxford > 0 OR collins > 0)"
    )
    n = 0
    while True:
        rows = cur.fetchmany(5000)
        if not rows:
            break
        out.executemany(
            "INSERT OR REPLACE INTO dict VALUES (?,?,?,?,?,?,?)",
            [(w.lower(), p, t, po, ex, b, f) for w, p, t, po, ex, b, f in rows],
        )
        n += len(rows)
        print(f"\r{8*9 and ''}{n} words", end="", flush=True)
    print()

    m = 0
    pairs = []
    with open(LEMMA, encoding="utf-8") as f:
        for line in f:
            line = line.strip().lower()
            if not line or line.startswith(";") or "->" not in line:
                continue
            base = line.split("->", 1)[0].split("/")[0].strip()
            infl = line.split("->", 1)[1].split(",")
            for w in infl:
                w = w.strip()
                if w and w != base:
                    pairs.append((w, base))
    out.executemany("INSERT OR REPLACE INTO lemma VALUES (?,?)", pairs)
    m = len(pairs)
    out.commit()
    out.execute("VACUUM")
    out.close()
    src.close()
    print(f"dict: {n} words, lemma: {m} mappings -> {DST} ({DST.stat().st_size/1e6:.1f} MB)")


if __name__ == "__main__":
    sys.exit(main())
