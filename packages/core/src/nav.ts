import type { Sentence } from './segment';

/** Binary search: index of the sentence active at time t, or -1 before the first. */
export function findAt(segments: Sentence[], t: number): number {
  if (!segments.length) return -1;
  let lo = 0;
  let hi = segments.length - 1;
  if (t < segments[0].start) return -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid];
    if (t < s.start) hi = mid - 1;
    else if (t > s.end) lo = mid + 1;
    else return mid;
  }
  // in the gap between sentences: attribute to the previous one
  const prev = Math.min(lo, segments.length - 1);
  return segments[prev] && t >= segments[prev].end ? prev : Math.max(0, prev - 1);
}

export interface NavResult {
  seekTo: number | null;
  index: number;
}

export function prevSentence(segments: Sentence[], idx: number, t: number): NavResult {
  if (!segments.length) return { seekTo: null, index: idx };
  const cur = findAt(segments, t);
  // if we are still in the first 1.2s of the sentence, restart it;
  // otherwise go to the previous sentence (classic "replay" semantics)
  const start = segments[cur]?.start ?? 0;
  const target = t - start < 1.2 && cur > 0 ? cur - 1 : Math.max(0, cur);
  return { seekTo: segments[target].start + 0.02, index: target };
}

export function nextSentence(segments: Sentence[], idx: number, t: number): NavResult {
  if (!segments.length) return { seekTo: null, index: idx };
  const cur = findAt(segments, t);
  const target = Math.min(segments.length - 1, cur + 1);
  return { seekTo: segments[target].start + 0.02, index: target };
}
