import { createHash } from 'node:crypto';
import { probe } from './audio';
import {
  detectKeyframes,
  transcribeMedia,
  type KeyframeInfo,
  type SpeechSegment,
  type SubtitleTrack,
} from './transcription';

export interface VmmTimelineEvent {
  timestamp_seconds: number;
  end_seconds?: number;
  layer: 'spoken' | 'keyframe' | 'onscreen_text' | 'marker';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface VideoMultimodalManifest {
  schema_version: 'isymcp-vmm/1';
  asset_id: string;
  source_sha256: string;
  duration_seconds: number;
  streams_summary: {
    has_video: boolean;
    has_audio: boolean;
    has_subtitles: boolean;
    video_codec?: string;
    audio_codec?: string;
    resolution?: string;
  };
  subtitles: {
    tracks: SubtitleTrack[];
    source: 'embedded_subtitles' | 'acoustic_fallback';
    segment_count: number;
    segments: SpeechSegment[];
  };
  keyframes: KeyframeInfo[];
  timeline: VmmTimelineEvent[];
  manifest_sha256: string;
}

/**
 * Construye el Video Multimodal Manifest (VMM) de forma completamente determinista.
 */
export async function buildVideoMultimodalManifest(
  assetId: string,
  sourceSha256: string,
  path: string,
): Promise<VideoMultimodalManifest> {
  const info = await probe(path);
  const videoStream = info.streams.find((s) => s.codec_type === 'video');
  const audioStream = info.streams.find((s) => s.codec_type === 'audio');

  const [keyframes, transcription] = await Promise.all([
    videoStream ? detectKeyframes(path) : Promise.resolve([]),
    transcribeMedia(path),
  ]);

  const timelineEvents: VmmTimelineEvent[] = [];

  // Agregar fotogramas clave al timeline
  for (const kf of keyframes) {
    timelineEvents.push({
      timestamp_seconds: kf.timestamp_seconds,
      layer: 'keyframe',
      content: `I-Frame at ${kf.timestamp_seconds.toFixed(2)}s (pts: ${kf.pts_time})`,
      metadata: { frame_type: kf.frame_type },
    });
  }

  // Agregar segmentos hablados al timeline
  for (const seg of transcription.segments) {
    timelineEvents.push({
      timestamp_seconds: seg.start_seconds,
      end_seconds: seg.end_seconds,
      layer: 'spoken',
      content: seg.text,
      metadata: {
        segment_id: seg.id,
        duration_seconds: seg.duration_seconds,
        word_count: seg.words?.length ?? 0,
      },
    });
  }

  // Orden cronológico estricto determinista
  timelineEvents.sort((a, b) => {
    if (a.timestamp_seconds !== b.timestamp_seconds) {
      return a.timestamp_seconds - b.timestamp_seconds;
    }
    // Si coinciden en tiempo, poner keyframe primero
    return a.layer === 'keyframe' ? -1 : 1;
  });

  const width = videoStream?.width ? Number(videoStream.width) : undefined;
  const height = videoStream?.height ? Number(videoStream.height) : undefined;

  const manifestBase: Omit<VideoMultimodalManifest, 'manifest_sha256'> = {
    schema_version: 'isymcp-vmm/1',
    asset_id: assetId,
    source_sha256: sourceSha256,
    duration_seconds: info.duration_seconds,
    streams_summary: {
      has_video: Boolean(videoStream),
      has_audio: Boolean(audioStream),
      has_subtitles: transcription.source === 'embedded_subtitles',
      video_codec: videoStream?.codec_name ? String(videoStream.codec_name) : undefined,
      audio_codec: audioStream?.codec_name ? String(audioStream.codec_name) : undefined,
      resolution: width && height ? `${width}x${height}` : undefined,
    },
    subtitles: {
      tracks: transcription.track ? [transcription.track] : [],
      source: transcription.source,
      segment_count: transcription.segments.length,
      segments: transcription.segments,
    },
    keyframes,
    timeline: timelineEvents,
  };

  const serialized = JSON.stringify(manifestBase);
  const manifestSha256 = createHash('sha256').update(serialized).digest('hex');

  return {
    ...manifestBase,
    manifest_sha256: manifestSha256,
  };
}

/**
 * Genera un resumen textual conciso del timeline apto para modelos LLM.
 */
export function formatVmmForLlm(vmm: VideoMultimodalManifest): string {
  const lines: string[] = [
    `# Video Multimodal Summary: ${vmm.asset_id}`,
    `Duración: ${vmm.duration_seconds.toFixed(2)}s | Resolución: ${vmm.streams_summary.resolution || 'N/A'} | Codec: ${vmm.streams_summary.video_codec || 'N/A'} / ${vmm.streams_summary.audio_codec || 'N/A'}`,
    `Hashes: source=${vmm.source_sha256.slice(0, 12)}... vmm=${vmm.manifest_sha256.slice(0, 12)}...`,
    `Keyframes: ${vmm.keyframes.length} | Segmentos de voz: ${vmm.subtitles.segment_count}`,
    '',
    '## Timeline Cronológico Sincronizado:',
  ];

  for (const ev of vmm.timeline) {
    const timeLabel = ev.end_seconds !== undefined
      ? `[${ev.timestamp_seconds.toFixed(2)}s - ${ev.end_seconds.toFixed(2)}s]`
      : `[${ev.timestamp_seconds.toFixed(2)}s]`;
    lines.push(`${timeLabel} (${ev.layer.toUpperCase()}): ${ev.content}`);
  }

  return lines.join('\n');
}
