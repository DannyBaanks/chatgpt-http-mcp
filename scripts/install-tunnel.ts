#!/usr/bin/env bun
// install-tunnel.ts — instala openai/tunnel-client (version pineada, SHA256
// verificado) e instala el runtime key + tunnel id en ~/.codex-web-http/.
//
// Port del comportamiento de codex-chatgpt-web (MIT): descarga el asset del
// release, valida un sha256 fijado en el codigo, extrae el binario, verifica --version, instala
// atomico y guarda la key con permisos 0600. NUNCA imprime secretos.
//
//   bun run scripts/install-tunnel.ts
//   bun run scripts/install-tunnel.ts --tunnel-file ~/Development/tunnel.txt \
//       --key-file "$HOME/Development/api key openai.txt" --force
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { securePrivatePath } from "../src/platform/private-path";

export const TUNNEL_VERSION = "0.0.12";
const RELEASE_BASE = `https://github.com/openai/tunnel-client/releases/download/v${TUNNEL_VERSION}`;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
/**
 * Hashes fijados en el codigo (de SHA256SUMS.txt de v0.0.12): un SHA256SUMS
 * bajado del mismo release solo detecta corrupcion, no un release alterado.
 * Subir TUNNEL_VERSION obliga a actualizar esta tabla a mano.
 */
const PINNED_ARCHIVE_SHA256: Record<string, string> = {
  "tunnel-client-v0.0.12-darwin-amd64.zip": "33de53aec680faafedc795f8f8268d6861577bddb871cb2d49529c91f88c2009",
  "tunnel-client-v0.0.12-darwin-arm64.zip": "42fb3138dc9c081d5777cb7e8bd1e041cc48b67c4978dbab3c5167ca1aabca02",
  "tunnel-client-v0.0.12-linux-amd64.zip": "2bb693bd7b5cd28da7ce09cd9e309529dbb33b7cc9dc0058e62a064688f92c81",
  "tunnel-client-v0.0.12-linux-arm64.zip": "6813878a3edb82ebebb32fe5a859bc6327a81cce5bc7b635a2313174d26365d6",
  "tunnel-client-v0.0.12-windows-amd64.zip": "2a2804933924e38a502d62b61f0266cb80d56d65744f4c29876b2bf9c1544356",
  "tunnel-client-v0.0.12-windows-arm64.zip": "65ab54221554481bb1c23b6015b99abe0b7f79b08593f4fb17a9e2e25532281d",
};

function home(): string {
  return process.env.CODEX_WEB_HTTP_HOME?.trim() || join(homedir(), ".codex-web-http");
}
function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
}
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function platformAsset(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform === "win32" ? "windows" : undefined;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : undefined;
  if (!os || !arch) throw new Error(`sin build pineado para ${process.platform}/${process.arch}`);
  return `tunnel-client-v${TUNNEL_VERSION}-${os}-${arch}.zip`;
}

function extractTunnelBinary(archivePath: string, outPath: string): void {
  if (process.platform === "win32") {
    const dir = `${outPath}.dir`;
    const encode = (value: string) => Buffer.from(value, "utf16le").toString("base64");
    const script = `$ErrorActionPreference='Stop'; $archive=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encode(archivePath)}')); $dir=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encode(dir)}')); $dest=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encode(outPath)}')); Expand-Archive -LiteralPath $archive -DestinationPath $dir -Force; $file=Get-ChildItem -LiteralPath $dir -Filter 'tunnel-client.exe' -File -Recurse | Select-Object -First 1; if ($null -eq $file) { throw 'asset sin tunnel-client.exe' }; Copy-Item -LiteralPath $file.FullName -Destination $dest -Force`;
    const result = Bun.spawnSync(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "ignore", stderr: "pipe", timeout: 30_000 });
    if (result.exitCode !== 0) throw new Error(`extraccion fallo: ${result.stderr.toString().slice(0, 300)}`);
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const py = `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1])\nnames=[n for n in z.namelist() if n.rstrip('/').split('/')[-1]=='tunnel-client']\nassert names, 'asset sin tunnel-client'\nopen(sys.argv[2],'wb').write(z.read(names[0]))`;
  const result = Bun.spawnSync(["python3", "-c", py, archivePath, outPath]);
  if (result.exitCode !== 0) throw new Error(`extraccion fallo: ${result.stderr.toString().slice(0, 300)}`);
}
async function fetchBytes(url: string): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!res.ok) throw new Error(`download ${res.status}: ${url}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("download supera el tope");
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}
function atomicWrite(path: string, bytes: Uint8Array, mode: number): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, bytes);
  if (process.platform === "win32") securePrivatePath(tmp, false);
  else chmodSync(tmp, mode);
  renameSync(tmp, path);
}
function runVersion(binary: string): string {
  const p = Bun.spawnSync([binary, "--version"]);
  return `${p.stdout.toString()}${p.stderr.toString()}`.trim();
}

export async function installTunnelClient(force = false): Promise<string> {
  const binDir = join(home(), "bin");
  const binary = join(binDir, process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
  const manifestPath = join(binDir, "tunnel-client-manifest.json");
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") securePrivatePath(binDir, true);

  if (!force && existsSync(binary) && existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { binarySha256?: string; tunnelClientVersion?: string };
    const actual = sha256(new Uint8Array(readFileSync(binary)));
    if (manifest.binarySha256 === actual && manifest.tunnelClientVersion === TUNNEL_VERSION
      && (process.platform === "win32" || (statSync(binary).mode & 0o111) !== 0)
      && runVersion(binary).includes(TUNNEL_VERSION)) {
      return binary;
    }
  }

  const asset = platformAsset();
  const expected = PINNED_ARCHIVE_SHA256[asset];
  if (!expected) throw new Error(`sin hash fijado para ${asset}; actualiza PINNED_ARCHIVE_SHA256`);
  const archive = await fetchBytes(`${RELEASE_BASE}/${asset}`);
  const archiveHash = sha256(archive);
  if (archiveHash !== expected) throw new Error(`checksum mismatch para ${asset}`);

  const archivePath = join(binDir, `${asset}.download`);
  writeFileSync(archivePath, archive);
  const outPath = join(binDir, process.platform === "win32" ? "tunnel-client.extract.exe" : "tunnel-client.extract");
  extractTunnelBinary(archivePath, outPath);
  const binaryBytes = new Uint8Array(readFileSync(outPath));
  const staged = `${binary}.install-${process.pid}`;
  atomicWrite(staged, binaryBytes, 0o700);
  const version = runVersion(staged);
  if (!version.includes(TUNNEL_VERSION)) throw new Error(`el binario no reporta ${TUNNEL_VERSION}: ${version.slice(0, 120)}`);
  renameSync(staged, binary);
  if (process.platform === "win32") securePrivatePath(binary, false);
  else chmodSync(binary, 0o700);
  writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    tunnelClientVersion: TUNNEL_VERSION,
    asset,
    archiveSha256: archiveHash,
    binarySha256: sha256(binaryBytes),
  }, null, 2) + "\n");
  for (const leftover of [archivePath, outPath]) rmSync(leftover, { force: true });
  return binary;
}

export function installRuntimeKey(sourceFile: string): string {
  if (!existsSync(sourceFile)) throw new Error(`no existe el archivo de key: ${sourceFile}`);
  const key = readFileSync(sourceFile, "utf8").trim();
  if (key.length === 0 || key.length > 64 * 1024) throw new Error("key vacia o demasiado grande");
  const dest = join(home(), "secrets", "tunnel-runtime.key");
  mkdirSync(join(home(), "secrets"), { recursive: true, mode: 0o700 });
  if (process.platform === "win32") securePrivatePath(join(home(), "secrets"), true);
  atomicWrite(dest, new TextEncoder().encode(key), 0o600);
  return dest;
}

export function installTunnelId(sourceFile: string): string {
  const raw = readFileSync(sourceFile, "utf8").trim();
  if (!/^tunnel_[a-f0-9]{32}$/.test(raw)) {
    throw new Error("tunnel id invalido: se espera tunnel_ seguido de 32 hex minusculas");
  }
  const dest = join(home(), "tunnel.json");
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  atomicWrite(dest, new TextEncoder().encode(JSON.stringify({
    tunnelId: raw,
    tunnelClientVersion: TUNNEL_VERSION,
    installedAt: new Date().toISOString(),
  }, null, 2) + "\n"), 0o600);
  return raw;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const tunnelFile = argValue(args, "--tunnel-file") ?? join(homedir(), "Development", "tunnel.txt");
  const keyFile = argValue(args, "--key-file") ?? join(homedir(), "Development", "api key openai.txt");
  const binary = await installTunnelClient(force);
  const keyPath = installRuntimeKey(keyFile);
  const tunnelId = installTunnelId(tunnelFile);
  console.log("tunnel-client instalado (sin imprimir secretos):");
  console.log(`  binario:   ${binary} (${runVersion(binary)})`);
  console.log(`  key:       ${keyPath} (${statSync(keyPath).size} bytes, 0600)`);
  console.log(`  tunnel id: ${tunnelId.slice(0, 15)}... (${tunnelId.length} chars)`);
  console.log("  NOTA: 'runtimes connect' requiere el MCP stdio propio (pendiente).");
}
