import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  parseTimestamp,
  parseVtt,
  searchTimelineText,
  detectSubtitleTracks,
  detectKeyframes,
  transcribeMedia,
} from '../src/media/transcription';
import { buildVideoMultimodalManifest, formatVmmForLlm } from '../src/media/vmm';
import { MediaCatalog } from '../src/media/catalog';
import { MediaService } from '../src/media/service';

describe('Media Transcription & Multimodal Manifest Suite', () => {
  test('TR-01: parseTimestamp converts WebVTT and SRT formats correctly', () => {
    expect(parseTimestamp('00:00:01.500')).toBe(1.5);
    expect(parseTimestamp('00:01:23.450')).toBe(83.45);
    expect(parseTimestamp('01:23.450')).toBe(83.45);
    expect(parseTimestamp('00:01:23,450')).toBe(83.45); // SRT comma
    expect(parseTimestamp('42.123')).toBe(42.123);
  });

  test('TR-02: parseVtt parses cues, cleans tags, and computes word-level timestamps', () => {
    const vtt = `WEBVTT
NOTE comment line

00:00.500 --> 00:02.500
<b>Hola</b> mundo prueba

00:03.000 --> 00:06.000
Error en el compilador de rust
`;
    const segments = parseVtt(vtt);
    expect(segments.length).toBe(2);

    expect(segments[0].id).toBe(1);
    expect(segments[0].start_seconds).toBe(0.5);
    expect(segments[0].end_seconds).toBe(2.5);
    expect(segments[0].text).toBe('Hola mundo prueba');
    expect(segments[0].words?.length).toBe(3);
    expect(segments[0].words?.[0].word).toBe('Hola');
    expect(segments[0].words?.[0].start_seconds).toBe(0.5);

    expect(segments[1].id).toBe(2);
    expect(segments[1].start_seconds).toBe(3.0);
    expect(segments[1].end_seconds).toBe(6.0);
    expect(segments[1].text).toBe('Error en el compilador de rust');
  });

  test('TR-03: searchTimelineText finds query matches with precise intervals', () => {
    const vtt = `WEBVTT

00:01.000 --> 00:03.000
Iniciamos el servidor con bun

00:04.000 --> 00:07.000
Se detecto un error crítico en el gateway

00:08.000 --> 00:10.000
Todo solucionado con éxito
`;
    const segments = parseVtt(vtt);

    const matchError = searchTimelineText(segments, 'error');
    expect(matchError.length).toBe(1);
    expect(matchError[0].segment_id).toBe(2);
    expect(matchError[0].context).toContain('error crítico');
    expect(matchError[0].start_seconds).toBeGreaterThanOrEqual(4.0);
    expect(matchError[0].end_seconds).toBeLessThanOrEqual(7.0);

    const matchBun = searchTimelineText(segments, 'bun');
    expect(matchBun.length).toBe(1);
    expect(matchBun[0].segment_id).toBe(1);

    const matchNone = searchTimelineText(segments, 'inexistente');
    expect(matchNone.length).toBe(0);
  });

  test('TR-04: End-to-end extraction from generated MP4 with embedded subtitles and VMM', async () => {
    const testDir = join(tmpdir(), `isymcp-test-vmm-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    try {
      const srtPath = join(testDir, 'test.srt');
      writeFileSync(
        srtPath,
        `1
00:00:00,500 --> 00:00:01,800
Primer paso de instalacion

2
00:00:02,000 --> 00:00:03,500
Ejecutamos el comando de prueba
`,
      );

      const mp4Path = join(testDir, 'video_with_subs.mp4');
      const gen = spawnSync('ffmpeg', [
        '-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=10',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
        '-i', srtPath,
        '-c:v', 'libx264', '-c:a', 'aac', '-c:s', 'mov_text',
        '-metadata:s:s:0', 'language=spa',
        mp4Path,
      ]);
      expect(gen.status).toBe(0);

      // 1. Detectar pistas
      const tracks = await detectSubtitleTracks(mp4Path);
      expect(tracks.length).toBe(1);
      expect(tracks[0].codec).toBe('mov_text');

      // 2. Extraer y transcribir
      const transcription = await transcribeMedia(mp4Path);
      expect(transcription.source).toBe('embedded_subtitles');
      expect(transcription.segment_count).toBe(2);
      expect(transcription.segments[0].text).toBe('Primer paso de instalacion');
      expect(transcription.segments[1].text).toBe('Ejecutamos el comando de prueba');

      // 3. Detectar keyframes
      const keyframes = await detectKeyframes(mp4Path);
      expect(keyframes.length).toBeGreaterThan(0);
      expect(keyframes[0].frame_type).toBe('I');

      // 4. Construir VMM
      const vmm = await buildVideoMultimodalManifest('media_test_asset', 'a'.repeat(64), mp4Path);
      expect(vmm.schema_version).toBe('isymcp-vmm/1');
      expect(vmm.duration_seconds).toBeGreaterThanOrEqual(3.9);
      expect(vmm.streams_summary.has_video).toBe(true);
      expect(vmm.streams_summary.has_audio).toBe(true);
      expect(vmm.streams_summary.has_subtitles).toBe(true);
      expect(vmm.manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(vmm.timeline.length).toBeGreaterThanOrEqual(3); // keyframe + 2 spoken segments

      // 5. Formatear para LLM
      const summary = formatVmmForLlm(vmm);
      expect(summary).toContain('Video Multimodal Summary');
      expect(summary).toContain('Primer paso de instalacion');
      expect(summary).toContain('KEYFRAME');
      expect(summary).toContain('SPOKEN');

      // 6. Validar a través de MediaCatalog y MediaService
      const catalog = new MediaCatalog(join(testDir, 'catalog'));
      const asset = await catalog.add(mp4Path);
      const service = new MediaService(catalog);

      // Call media_transcribe
      const transcribeRes = await service.call('media_transcribe', { asset_id: asset.id });
      expect(transcribeRes.isError).toBeFalsy();
      const transcribeData = JSON.parse(transcribeRes.content[0].text!);
      expect(transcribeData.result.source).toBe('embedded_subtitles');
      expect(transcribeData.result.segment_count).toBe(2);

      // Call media_timeline_search
      const searchRes = await service.call('media_timeline_search', { asset_id: asset.id, query: 'comando' });
      expect(searchRes.isError).toBeFalsy();
      const searchData = JSON.parse(searchRes.content[0].text!);
      expect(searchData.result.match_count).toBe(1);
      expect(searchData.result.matches[0].context).toContain('Ejecutamos el comando');

      // Call video_vmm
      const vmmRes = await service.call('video_vmm', { asset_id: asset.id });
      expect(vmmRes.isError).toBeFalsy();
      const vmmData = JSON.parse(vmmRes.content[0].text!);
      expect(vmmData.result.vmm.manifest_sha256).toBeDefined();
      expect(vmmData.result.summary).toContain('Video Multimodal Summary');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  }, 30000);
});
