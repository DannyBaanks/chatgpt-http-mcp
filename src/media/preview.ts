import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { youtubeSource } from './importer';
import { run } from './process';
import { youtubeDownloaderBinary } from './youtube';

export type YouTubePreview = {
  url: string;
  video_id: string;
  title?: string;
  uploader?: string;
  duration_seconds?: number;
  resolution?: string;
  estimated_bytes?: number;
};

type YouTubeMetadata = {
  id?: unknown;
  title?: unknown;
  uploader?: unknown;
  channel?: unknown;
  duration?: unknown;
  width?: unknown;
  height?: unknown;
  filesize?: unknown;
  filesize_approx?: unknown;
};

function safeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  return normalized || undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function canonicalVideoId(url: string): string {
  const id = new URL(url).searchParams.get('v');
  if (!id) throw Error('Invalid canonical YouTube video URL');
  return id;
}

function parseMetadata(output: Buffer, canonicalUrl: string): YouTubePreview {
  let metadata: YouTubeMetadata;
  try {
    const value: unknown = JSON.parse(output.toString('utf8').trim());
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw Error('not an object');
    metadata = value as YouTubeMetadata;
  } catch {
    throw Error('YouTube metadata response was invalid');
  }

  const videoId = canonicalVideoId(canonicalUrl);
  if (metadata.id !== videoId) throw Error('YouTube video identity did not match the canonical URL');

  const width = positiveNumber(metadata.width);
  const height = positiveNumber(metadata.height);
  const fileSize = positiveNumber(metadata.filesize) ?? positiveNumber(metadata.filesize_approx);
  const duration = positiveNumber(metadata.duration);
  const preview: YouTubePreview = { url: canonicalUrl, video_id: videoId };
  const title = safeText(metadata.title, 300);
  const uploader = safeText(metadata.uploader ?? metadata.channel, 200);
  if (title) preview.title = title;
  if (uploader) preview.uploader = uploader;
  if (duration !== undefined) preview.duration_seconds = duration;
  if (width !== undefined && height !== undefined) preview.resolution = `${Math.trunc(width)}x${Math.trunc(height)}`;
  if (fileSize !== undefined && Number.isSafeInteger(fileSize)) preview.estimated_bytes = fileSize;
  return preview;
}

export async function inspectYouTube(input: string, runner: typeof run = run): Promise<YouTubePreview> {
  const canonicalUrl = youtubeSource(input);
  const output = await runner(youtubeDownloaderBinary(), [
    '--ignore-config', '--no-plugin-dirs', '--no-cache-dir', '--no-playlist', '--skip-download',
    '--no-progress', '--no-warnings', '--socket-timeout', '10', '--retries', '1',
    '--match-filters', '!is_live & duration <= 1800', '--dump-single-json', canonicalUrl,
  ], 1024 * 1024, 60000, {
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: homedir(),
      TMPDIR: process.env.TMPDIR || '/tmp',
      LANG: process.env.LANG || 'C.UTF-8',
    },
    processGroup: true,
  });
  return parseMetadata(output, canonicalUrl);
}

function executableInPath(name: string, pathValue: string): string | undefined {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* try the next PATH entry */ }
  }
  return undefined;
}

function validateSelectedDirectory(value: string): string {
  const selected = value.trim();
  if (!isAbsolute(selected)) throw Error('The folder chooser returned an invalid directory');
  try {
    const realPath = realpathSync(selected);
    if (!statSync(realPath).isDirectory()) throw Error('not a directory');
    return realPath;
  } catch {
    throw Error('The selected output folder is unavailable');
  }
}

export async function chooseOutputDirectory(options: {
  platform?: NodeJS.Platform;
  runner?: typeof run;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') throw Error('The native folder chooser is currently supported on Linux only');
  const env = options.env ?? process.env;
  const pathValue = env.PATH ?? '/usr/bin:/bin';
  const zenity = executableInPath('zenity', pathValue);
  const kdialog = executableInPath('kdialog', pathValue);
  const command = zenity ?? kdialog;
  if (!command) throw Error('No native folder chooser was found; install zenity or kdialog and retry');

  const args = zenity
    ? ['--file-selection', '--directory', '--title=Choose a folder for the prepared video']
    : ['--getexistingdirectory', env.HOME ?? homedir()];
  try {
    const output = await (options.runner ?? run)(command, args, 64 * 1024, 120000, {
      env: { ...env, PATH: pathValue },
    });
    const selected = output.toString('utf8').trim();
    return selected ? validateSelectedDirectory(selected) : null;
  } catch (error) {
    if (/Media process failed \(1\)/.test(error instanceof Error ? error.message : String(error))) return null;
    throw Error('The native folder chooser could not be opened; check your desktop session and retry');
  }
}
