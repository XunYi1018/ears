import type { BiliSubtitleLine, Sentence, Word } from './segment';

export interface SegmentOptions {
  /** merge lines until one of these terminal punctuation marks ends a line */
  endPunct?: RegExp;
  /** never merge beyond this many chars (per language) */
  maxChars?: number;
  /** never merge into a sentence longer than this many seconds */
  maxDur?: number;
  /** a gap larger than this (s) between lines forces a boundary */
  maxGap?: number;
}

const DEFAULTS: Required<SegmentOptions> = {
  endPunct: /[.!?。！？；;]/,
  maxChars: 60,
  maxDur: 8,
  maxGap: 1.2,
};

/**
 * Re-segment platform subtitle lines (clause-level) into sentence-level
 * entries. Merged sentences keep [first.start, last.end]; the zh text of
 * merged lines is concatenated (spaces kept for latin text).
 */
export function linesToSentences(lines: BiliSubtitleLine[], opts: SegmentOptions = {}): Sentence[] {
  const o = { ...DEFAULTS, ...opts };
  const isLatin = /^[\x00-\xff]/.test((lines[0]?.content ?? '') + ' ');
  const maxChars = opts.maxChars ?? (isLatin ? 90 : 40);
  const out: Sentence[] = [];
  let cur: BiliSubtitleLine[] = [];

  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((l) => l.content.trim()).join(isLatin ? ' ' : '');
    out.push({
      id: out.length,
      start: round(cur[0].from),
      end: round(cur[cur.length - 1].to),
      zh: text,
    });
    cur = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.content?.trim()) continue;
    const prev = cur[cur.length - 1];
    const gap = prev ? line.from - prev.to : 0;
    const mergedText = (cur.map((l) => l.content.trim()).join(isLatin ? ' ' : '') + (isLatin ? ' ' : '') + line.content.trim()).length;
    const mergedDur = line.to - (cur[0]?.from ?? line.from);

    const prevEnds = prev ? o.endPunct.test(prev.content.trim().slice(-2)) : false;
    const forcedBreak = (cur.length > 0 && (gap > o.maxGap || mergedText > maxChars || mergedDur > o.maxDur)) || prevEnds;
    if (forcedBreak) flush();
    cur.push(line);
    // a line ending with terminal punctuation closes the sentence
    if (o.endPunct.test(line.content.trim().slice(-2))) flush();
  }
  flush();

  // sanitize: monotonic, non-empty, positive duration
  let last = -1;
  return out.filter((s) => {
    if (!(s.end > s.start) || s.start < last) return false;
    last = s.end;
    return true;
  });
}

/**
 * Build sentences from ASR output (whisper segments with optional words).
 * ASR text is roughly sentence-like already; we merge/split on punctuation.
 */
export function asrToSentences(
  segs: { start: number; end: number; text: string; words?: Word[] }[],
  opts: SegmentOptions = {},
): Sentence[] {
  const o = { ...DEFAULTS, ...opts };
  const endPunct = /[.!?]/;
  const out: Sentence[] = [];
  let curWords: Word[] = [];
  let curText = '';

  const flush = () => {
    if (!curWords.length) return;
    out.push({
      id: out.length,
      start: round(curWords[0].s),
      end: round(curWords[curWords.length - 1].e),
      en: curText.trim(),
      words: curWords,
    });
    curWords = [];
    curText = '';
  };

  for (const seg of segs) {
    if (seg.words?.length) {
      for (const w of seg.words) {
        if (!/\S/.test(w.t)) continue;
        curWords.push(w);
        curText += (curText && !/^[,.!?;:'")\]]/.test(w.t) ? ' ' : '') + w.t;
        if (endPunct.test(w.t.slice(-1)) || curText.length > o.maxChars) flush();
      }
    } else {
      curText += (curText ? ' ' : '') + seg.text;
      curWords = [];
      out.push({ id: out.length, start: round(seg.start), end: round(seg.end), en: seg.text });
      curText = '';
    }
  }
  flush();
  return out;
}

/**
 * Merge an EN sentence list and a ZH sentence list (independently segmented)
 * into bilingual sentences: each EN sentence takes the ZH text with maximal
 * time overlap. ZH text is concatenated when one EN sentence spans several
 * ZH lines.
 */
export function mergeBilingual(en: Sentence[], zh: Sentence[]): Sentence[] {
  const used = new Set<number>();
  return en.map((e, i) => {
    let best = -1;
    let bestOv = 0;
    for (let j = 0; j < zh.length; j++) {
      if (used.has(j)) continue;
      const ov = Math.min(e.end, zh[j].end) - Math.max(e.start, zh[j].start);
      if (ov > bestOv) { bestOv = ov; best = j; }
    }
    let z = '';
    if (best >= 0 && bestOv > 0.05) {
      used.add(best);
      z = zh[best].zh ?? '';
      // pull in following zh lines that overlap this en sentence
      for (let k = best + 1; k < zh.length; k++) {
        const ov = Math.min(e.end, zh[k].end) - Math.max(e.start, zh[k].start);
        if (ov > 0.05 && !used.has(k)) { used.add(k); z += zh[k].zh ?? ''; }
        else break;
      }
    }
    return { ...e, id: i, zh: z || undefined };
  });
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
