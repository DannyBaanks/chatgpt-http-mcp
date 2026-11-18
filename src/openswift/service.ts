// src/openswift/service.ts — Integración de OpenSwift Simulator Screenshot para ISyMCP.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

export function defaultOpenSwiftDir(): string {
  return process.env.OPENSWIFT_DIR?.trim() || resolve(import.meta.dir, "..", "..", "..", "OpenSwift");
}

function pythonBin(): string {
  if (process.platform === "win32") return "python";
  return "python3";
}

export interface OpenSwiftScreenshotOptions {
  /** Ruta a un archivo .swift (absoluta, relativa a cwd o relativa a OpenSwift). */
  file?: string;
  /** Alias de file. */
  path?: string;
  /** Código fuente SwiftUI en línea (si no se pasa file/path). */
  source?: string;
  /** Alias de source. */
  code?: string;
  /** Directorio base para resolver rutas relativas. */
  cwd?: string;
  /** Dispositivo(s): ej. 'iphone-16-pro', 'iphone-12,iphone-16-pro', 'phones', 'ipads', 'all'. */
  device?: string;
  /** Tema visual: 'dark' | 'light' | 'both' (por defecto 'dark'). */
  appearance?: "dark" | "light" | "both" | string;
  /** Color de carcasa: 'black' | 'natural' | 'white' | 'blue' | 'none' (por defecto 'black'). */
  frame?: "black" | "natural" | "white" | "blue" | "none" | string;
  /** Orientación: 'portrait' | 'landscape' (por defecto 'portrait'). */
  orientation?: "portrait" | "landscape" | string;
  /** Densidad de píxeles PNG (1..3, por defecto 2). */
  scale?: number;
  /** Ruta donde guardar el PNG generado. */
  output?: string;
  /** Si es true (por defecto), adjunta el bloque MCP image (base64 PNG) para inspección visual directa del modelo. */
  include_image?: boolean;
}

export interface OpenSwiftScreenshotResult {
  ok: boolean;
  png_path?: string;
  svg_path?: string | null;
  sha256?: string;
  bytes?: number;
  raster_engine?: string;
  devices?: string[];
  appearance?: string;
  frame?: string;
  orientation?: string;
  scale?: number;
  logical_width?: number;
  logical_height?: number;
  pixel_width?: number;
  pixel_height?: number;
  problems?: string[];
  tree?: Record<string, unknown> | null;
  error?: string;
  _mcp_image?: {
    type: "image";
    data: string;
    mimeType: "image/png";
  };
}

function resolveSwiftFile(rawPath: string, cwd?: string, openSwiftDir = defaultOpenSwiftDir()): string | null {
  const candidates: string[] = [];
  if (isAbsolute(rawPath)) {
    candidates.push(rawPath);
  } else {
    if (cwd) candidates.push(resolve(cwd, rawPath));
    candidates.push(resolve(process.cwd(), rawPath));
    candidates.push(resolve(openSwiftDir, rawPath));
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export function listOpenSwiftDevices(openSwiftDir = defaultOpenSwiftDir()): {
  ok: boolean;
  devices?: Array<{
    id: string;
    name: string;
    idiom: string;
    width: number;
    height: number;
    notch_type: string;
    has_action_button: boolean;
    has_camera_control: boolean;
  }>;
  appearances?: string[];
  frames?: string[];
  orientations?: string[];
  presets?: string[];
  error?: string;
} {
  if (!existsSync(join(openSwiftDir, "openswift", "devices.py"))) {
    return { ok: false, error: `OpenSwift no encontrado en ${openSwiftDir}` };
  }
  const py = [
    "import json",
    "from openswift.devices import DEVICES, ORIENTATIONS",
    "from openswift.render import APPEARANCES, FRAMES",
    "print(json.dumps({",
    '  "devices": [',
    '    {"id": d.id, "name": d.name, "idiom": d.idiom, "width": d.width, "height": d.height,',
    '     "notch_type": d.notch_type.value, "has_action_button": d.has_action_button, "has_camera_control": d.has_camera_control}',
    "    for d in DEVICES.values()",
    "  ],",
    '  "appearances": [*APPEARANCES, "both"],',
    '  "frames": list(FRAMES),',
    '  "orientations": list(ORIENTATIONS),',
    '  "presets": ["phones", "ipads", "all"]',
    "}))",
  ].join("\n");

  const proc = spawnSync(pythonBin(), ["-c", py], {
    cwd: openSwiftDir,
    env: { ...process.env, PYTHONPATH: openSwiftDir },
    encoding: "utf-8",
    timeout: 15_000,
  });
  if (proc.status !== 0) {
    return { ok: false, error: (proc.stderr || proc.stdout || "Error al consultar dispositivos de OpenSwift").trim() };
  }
  try {
    return { ok: true, ...JSON.parse(proc.stdout.trim()) };
  } catch (err) {
    return { ok: false, error: `Respuesta JSON inválida de OpenSwift: ${(err as Error).message}` };
  }
}

export async function captureOpenSwiftScreenshot(
  options: OpenSwiftScreenshotOptions = {},
  openSwiftDir = defaultOpenSwiftDir(),
): Promise<OpenSwiftScreenshotResult> {
  if (!existsSync(join(openSwiftDir, "openswift", "__main__.py"))) {
    return { ok: false, error: `OpenSwift no encontrado en ${openSwiftDir}` };
  }

  const rawFile = (options.file ?? options.path ?? "").trim();
  const inlineSource = options.source ?? options.code;

  if (!rawFile && (!inlineSource || !String(inlineSource).trim())) {
    return {
      ok: false,
      error: "Debes proporcionar 'file' (ruta a un archivo .swift) o 'source' (código SwiftUI en línea).",
    };
  }

  let sourceArg = "-";
  let stdinText: string | undefined;
  let stem = "inline";

  if (rawFile) {
    const resolved = resolveSwiftFile(rawFile, options.cwd, openSwiftDir);
    if (!resolved) {
      return { ok: false, error: `Archivo Swift no encontrado: ${rawFile}` };
    }
    sourceArg = resolved;
    stem = basename(resolved, ".swift").replace(/[^A-Za-z0-9_.-]/g, "_") || "view";
  } else {
    stdinText = String(inlineSource);
  }

  const device = (options.device ?? "iphone-16-pro").trim() || "iphone-16-pro";
  const appearance = (options.appearance ?? "dark").trim() || "dark";
  const frame = (options.frame ?? "black").trim() || "black";
  const orientation = (options.orientation ?? "portrait").trim() || "portrait";
  const scale = Math.max(1, Math.min(3, Math.trunc(Number(options.scale ?? 2) || 2)));

  const outDir = join(tmpdir(), "isymcp-openswift");
  mkdirSync(outDir, { recursive: true });
  const safeDev = device.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  const outPng = options.output
    ? (isAbsolute(options.output) ? options.output : resolve(options.cwd ?? process.cwd(), options.output))
    : join(outDir, `${stem}-${safeDev}-${appearance}-${orientation}.png`);
  const outSvg = outPng.replace(/\.png$/i, "") + ".svg";

  const argv = [
    "-m",
    "openswift",
    "screenshot",
    sourceArg,
    "-o",
    outPng,
    "--svg-output",
    outSvg,
    "--device",
    device,
    "--appearance",
    appearance,
    "--frame",
    frame,
    "--orientation",
    orientation,
    "--scale",
    String(scale),
    "--json",
  ];

  const proc = spawnSync(pythonBin(), argv, {
    cwd: openSwiftDir,
    env: { ...process.env, PYTHONPATH: openSwiftDir },
    input: stdinText,
    encoding: "utf-8",
    timeout: 60_000,
  });

  if (proc.status !== 0) {
    return {
      ok: false,
      error: (proc.stderr || proc.stdout || `openswift exited with status ${proc.status}`).trim(),
    };
  }

  let parsed: OpenSwiftScreenshotResult;
  try {
    parsed = JSON.parse(proc.stdout.trim()) as OpenSwiftScreenshotResult;
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo parsear la salida JSON de OpenSwift: ${(err as Error).message}`,
    };
  }

  if (options.include_image !== false && parsed.png_path && existsSync(parsed.png_path)) {
    const pngBuffer = readFileSync(parsed.png_path);
    parsed._mcp_image = {
      type: "image",
      data: pngBuffer.toString("base64"),
      mimeType: "image/png",
    };
  }

  return parsed;
}
