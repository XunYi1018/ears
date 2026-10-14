export interface Word {
  t: string;
  s: number;
  e: number;
}

export interface Sentence {
  id: number;
  start: number;
  end: number;
  en?: string;
  zh?: string;
  words?: Word[];
}

export interface SegmentTrack {
  v: 1;
  pipeline: number;
  key: string;
  src: 'official' | 'ai' | 'asr' | 'hybrid';
  audioOffsetMs: number;
  lang: 'en' | 'zh';
  segments: Sentence[];
}

export interface BiliSubtitleLine {
  from: number;
  to: number;
  content: string;
}

export interface BiliSubtitleBody {
  body: BiliSubtitleLine[];
}
