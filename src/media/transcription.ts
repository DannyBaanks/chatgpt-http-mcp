import { run } from './process';
import { audioSegments } from './audio';

export interface SubtitleTrack {
  index: number;
  codec: string;
  language?: string;
  title?: string;
}

export interface SpeechWord {
  word: string;
  start_seconds: number;
  end_seconds: number;
}

export interface SpeechSegment {
  id: number;
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
  text: string;
  words?: SpeechWord[];
}

export interface KeyframeInfo {
  timestamp_seconds: number;
  frame_type: 'I';
  pts_time: number;
}

export interface TimelineMatch {
  segment_id: number;
  start_seconds: number;
  end_seconds: number;
  matched_text: string;
  context: string;
}

export interface TranscriptionResult {
  source: 'embedded_subtitles' | 'acoustic_fallback';
  track?: SubtitleTrack;
  segment_count: number;
  full_text: string;
  segments: SpeechSegment[];
}

/**
 * Convierte un timestamp WebVTT o SRT (HH:MM:SS.mmm, MM:SS.mmm o HH:MM:SS,mmm)
 * a segundos flotantes de forma determinista.
 */
export function parseTimestamp(timeStr: string): number {
  const normalized = timeStr.trim().replace(',', '.');
  const parts = normalized.split(':');
  if (parts.length === 3) {
    const hours = parseFloat(parts[0]);
    const minutes = parseFloat(parts[1]);
    const seconds = parseFloat(parts[2]);
    return Number((hours * 3600 + minutes * 60 + seconds).toFixed(3));
  }
  if (parts.length === 2) {
    const minutes = parseFloat(parts[0]);
    const seconds = parseFloat(parts[1]);
    return Number((minutes * 60 + seconds).toFixed(3));
  }
  const val = parseFloat(normalized);
  return Number.isFinite(val) ? val : 0;
}

/**
 * Detecta pistas de subtítulos o texto temporizado embebidas en el contenedor.
 */
export async function detectSubtitleTracks(path: string): Promise<SubtitleTrack[]> {
  try {
    const stdout = await run('ffprobe', [
      '-v', 'error',
      '-protocol_whitelist', 'file,pipe',
      '-select_streams', 's',
      '-show_entries', 'stream=index,codec_name:stream_tags=language,title',
      '-of', 'json',
      path,
    ]);
    const parsed = JSON.parse(stdout.toString());
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    return streams.map((s: any) => ({
      index: Number(s.index),
      codec: String(s.codec_name || 'unknown'),
      language: s.tags?.language ? String(s.tags.language) : undefined,
      title: s.tags?.title ? String(s.tags.title) : undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * Parsea un archivo o flujo WebVTT a segmentos estructurados con timestamps por palabra.
 */
export function parseVtt(vttContent: string): SpeechSegment[] {
  const lines = vttContent.replace(/\r\n/g, '\n').split('\n');
  const segments: SpeechSegment[] = [];
  const cueRegex = /((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})/;

  let currentStart = 0;
  let currentEnd = 0;
  let currentText: string[] = [];
  let inCue = false;
  let cueId = 0;

  function flushCue() {
    if (inCue && currentText.length > 0 && currentEnd > currentStart) {
      const cleanText = currentText.join(' ').replace(/<[^>]+>/g, '').trim();
      if (cleanText) {
        cueId++;
        const duration = Number((currentEnd - currentStart).toFixed(3));
        const words = cleanText.split(/\s+/).filter(Boolean);
        const speechWords: SpeechWord[] = [];
        if (words.length > 0) {
          const step = duration / words.length;
          for (let i = 0; i < words.length; i++) {
            const wStart = Number((currentStart + i * step).toFixed(3));
            const wEnd = Number((currentStart + (i + 1) * step).toFixed(3));
            speechWords.push({ word: words[i], start_seconds: wStart, end_seconds: wEnd });
          }
        }
        segments.push({
          id: cueId,
          start_seconds: currentStart,
          end_seconds: currentEnd,
          duration_seconds: duration,
          text: cleanText,
          words: speechWords,
        });
      }
    }
    currentText = [];
    inCue = false;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'WEBVTT' || trimmed.startsWith('NOTE') || trimmed.startsWith('STYLE')) {
      continue;
    }
    const match = trimmed.match(cueRegex);
    if (match) {
      flushCue();
      currentStart = parseTimestamp(match[1]);
      currentEnd = parseTimestamp(match[2]);
      inCue = true;
    } else if (inCue) {
      if (trimmed === '') {
        flushCue();
      } else {
        currentText.push(trimmed);
      }
    }
  }
  flushCue();
  return segments;
}

/**
 * Extrae fotogramas clave I-frame directamente usando ffprobe de forma determinista.
 */
export async function detectKeyframes(path: string, maxFrames = 100): Promise<KeyframeInfo[]> {
  try {
    const stdout = await run('ffprobe', [
      '-v', 'error',
      '-protocol_whitelist', 'file,pipe',
      '-select_streams', 'v',
      '-skip_frame', 'nokey',
      '-show_entries', 'frame=pts_time,best_effort_timestamp_time,pict_type',
      '-of', 'json',
      path,
    ]);
    const parsed = JSON.parse(stdout.toString());
    const frames = Array.isArray(parsed.frames) ? parsed.frames : [];
    const keyframes: KeyframeInfo[] = [];
    for (const f of frames) {
      const timeStr = f.pts_time ?? f.best_effort_timestamp_time;
      const t = parseFloat(timeStr);
      if (Number.isFinite(t)) {
        keyframes.push({
          timestamp_seconds: Number(t.toFixed(3)),
          frame_type: 'I',
          pts_time: Number(t.toFixed(3)),
        });
        if (keyframes.length >= maxFrames) break;
      }
    }
    return keyframes;
  } catch {
    return [];
  }
}

/**
 * Transcribe un archivo de video deterministamente.
 * 1. Prioriza pistas de subtítulos embebidas (resolución exacta a nivel palabra).
 * 2. Si no existen, utiliza detección acústica de actividad de voz para segmentar el audio.
 */
export async function transcribeMedia(
  path: string,
  options: { trackIndex?: number } = {},
): Promise<TranscriptionResult> {
  const tracks = await detectSubtitleTracks(path);
  if (tracks.length > 0) {
    const selectedTrack = options.trackIndex !== undefined
      ? tracks.find((t) => t.index === options.trackIndex) || tracks[0]
      : tracks[0];

    const vttBuffer = await run('ffmpeg', [
      '-v', 'error',
      '-nostdin',
      '-protocol_whitelist', 'file,pipe',
      '-i', path,
      '-map', `0:${selectedTrack.index}`,
      '-f', 'webvtt',
      'pipe:1',
    ]);
    const segments = parseVtt(vttBuffer.toString());
    const fullText = segments.map((s) => s.text).join('\n');
    return {
      source: 'embedded_subtitles',
      track: selectedTrack,
      segment_count: segments.length,
      full_text: fullText,
      segments,
    };
  }

  // Fallback acústico: segmenta los tramos de voz/energía del audio
  try {
    const audioActivity = await audioSegments(path, 0, 120, {
      thresholdDbfs: -32,
      mergeGapSeconds: 0.15,
      minSegmentSeconds: 0.2,
    });
    const segments: SpeechSegment[] = audioActivity.segments.map((seg, idx) => ({
      id: idx + 1,
      start_seconds: seg.start_seconds,
      end_seconds: seg.end_seconds,
      duration_seconds: Number((seg.end_seconds - seg.start_seconds).toFixed(3)),
      text: `[Audio segment ${idx + 1}: ${seg.duration_seconds.toFixed(2)}s, RMS: ${seg.rms_dbfs.toFixed(1)} dBFS]`,
    }));
    return {
      source: 'acoustic_fallback',
      segment_count: segments.length,
      full_text: segments.map((s) => s.text).join('\n'),
      segments,
    };
  } catch {
    return {
      source: 'acoustic_fallback',
      segment_count: 0,
      full_text: '',
      segments: [],
    };
  }
}

/**
 * Realiza una búsqueda temporal indexada en los segmentos del video.
 */
export function searchTimelineText(
  segments: SpeechSegment[],
  query: string,
  limit = 20,
): TimelineMatch[] {
  if (!query || !query.trim()) return [];
  const cleanQuery = query.trim().toLowerCase();
  const matches: TimelineMatch[] = [];

  for (const seg of segments) {
    const segTextLower = seg.text.toLowerCase();
    if (segTextLower.includes(cleanQuery)) {
      // Si tenemos marcas por palabra, buscar el rango más acotado
      let matchStart = seg.start_seconds;
      let matchEnd = seg.end_seconds;
      if (seg.words && seg.words.length > 0) {
        const wordMatch = seg.words.find((w) => w.word.toLowerCase().includes(cleanQuery));
        if (wordMatch) {
          matchStart = wordMatch.start_seconds;
          matchEnd = wordMatch.end_seconds;
        }
      }
      matches.push({
        segment_id: seg.id,
        start_seconds: matchStart,
        end_seconds: matchEnd,
        matched_text: query,
        context: seg.text,
      });
      if (matches.length >= limit) break;
    }
  }
  return matches;
}
