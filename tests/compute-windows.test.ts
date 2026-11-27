/** Pruebas del lado Windows del contrato Hive+Link+Compute v1 (owner: Windows Xeon). */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processMatchesTable } from "../src/platform/process";
import { parseNvidiaSmiOutput, probeGpuTelemetry, readGpuTelemetry } from "../src/compute/gpu-telemetry";
import { mapWinPriorityClass, winComputeExecutor } from "../src/compute/exec-win";
import { parseWslDistroList, windowsPathToWsl, wslComputeExecutor } from "../src/compute/exec-wsl";
import type { ComputeExecRequest } from "../src/compute/types";

const ON_WINDOWS = process.platform === "win32";
const wslAvailable = await wslComputeExecutor.isAvailable();
// Docker-desktop (y otras distros minimalistas) no montan /mnt/c: los tests usan
// un cwd nativo de WSL en ese caso y ejercitan el fallo controlado aparte.
const wslSeesWindowsDrives = wslAvailable && ON_WINDOWS &&
  Bun.spawnSync(["wsl.exe", "--", "test", "-d", "/mnt/c"]).exitCode === 0;
const wslTestCwd = wslSeesWindowsDrives ? tmpdir() : "/tmp";

function jobRequest(overrides: Partial<ComputeExecRequest> = {}): ComputeExecRequest {
  const jobDir = mkdtempSync(join(tmpdir(), "isymcp-compute-win-"));
  return {
    job_id: "job-test-0001",
    job_dir: jobDir,
    cwd: jobDir,
    priority: "normal",
    target: "win",
    stdout_path: join(jobDir, "stdout.log"),
    stderr_path: join(jobDir, "stderr.log"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// windowsPathToWsl — puro, corre en cualquier OS
// ---------------------------------------------------------------------------
test("windowsPathToWsl traduce rutas de unidad Windows", () => {
  expect(windowsPathToWsl("C:\\Projects\\demo\\work")).toBe("/mnt/c/Projects/demo/work");
  expect(windowsPathToWsl("C:\\")).toBe("/mnt/c");
  expect(windowsPathToWsl("d:/Data/ISyCo")).toBe("/mnt/d/Data/ISyCo");
  expect(windowsPathToWsl("C:\\espacio con\\nombre")).toBe("/mnt/c/espacio con/nombre");
});

test("windowsPathToWsl deja intactas las rutas ya POSIX", () => {
  expect(windowsPathToWsl("/var/tmp/work")).toBe("/var/tmp/work");
  expect(windowsPathToWsl("/mnt/c/ya-traducida")).toBe("/mnt/c/ya-traducida");
  expect(windowsPathToWsl("ruta/relativa")).toBe("ruta/relativa");
});

test("parseWslDistroList decodifica UTF-16LE con BOM/CRLF y vacio = sin distros", () => {
  const utf16 = (s: string) => new Uint8Array(Buffer.from(s, "utf16le"));
  expect(parseWslDistroList(utf16(String.fromCharCode(0xfeff) + "Ubuntu\r\ndocker-desktop\r\n"))).toEqual(["Ubuntu", "docker-desktop"]);
  expect(parseWslDistroList(utf16(""))).toEqual([]);
  expect(parseWslDistroList(utf16("\r\n  \r\n"))).toEqual([]);
});

// ---------------------------------------------------------------------------
// mapWinPriorityClass — puro
// ---------------------------------------------------------------------------
test("mapWinPriorityClass mapea la prioridad del contrato a clases de Windows", () => {
  expect(mapWinPriorityClass("idle")).toBe("Idle");
  expect(mapWinPriorityClass("below_normal")).toBe("BelowNormal");
  expect(mapWinPriorityClass("normal")).toBe("Normal");
});

// ---------------------------------------------------------------------------
// gpu-telemetry
// ---------------------------------------------------------------------------
test("parseNvidiaSmiOutput interpreta lineas csv,noheader,nounits", () => {
  const gpus = parseNvidiaSmiOutput(
    "0, NVIDIA GeForce RTX 4060, 8188, 875, 7313, 3, 44\r\n",
  );
  expect(gpus).toHaveLength(1);
  expect(gpus[0]).toEqual({
    index: 0,
    name: "NVIDIA GeForce RTX 4060",
    vram_total_mb: 8188,
    vram_used_mb: 875,
    vram_free_mb: 7313,
    utilization_pct: 3,
    temperature_c: 44,
  });
});

test("parseNvidiaSmiOutput degrada campos [N/A] a null y soporta nombres con coma", () => {
  const gpus = parseNvidiaSmiOutput(
    '1, "GeForce GTX, 1050 Ti", 4096, 0, 4096, [N/A], [Not Supported]\n',
  );
  expect(gpus[0].name).toBe("GeForce GTX, 1050 Ti");
  expect(gpus[0].utilization_pct).toBeNull();
  expect(gpus[0].temperature_c).toBeNull();
});

test("parseNvidiaSmiOutput devuelve [] con salida vacia o basura", () => {
  expect(parseNvidiaSmiOutput("")).toEqual([]);
  expect(parseNvidiaSmiOutput("una linea que no es csv\n")).toEqual([]);
});

test("probeGpuTelemetry nunca lanza con un binario inexistente", async () => {
  const snap = await probeGpuTelemetry("no-existe-nvidia-smi-xyz-12345", 2000);
  expect(snap.available).toBe(false);
  expect(snap.provider).toBe("none");
  expect(snap.gpus).toEqual([]);
  expect(snap.error).toBeTruthy();
});

test("readGpuTelemetry cachea por TTL y respeta forceRefresh", async () => {
  const first = await readGpuTelemetry({ cacheTtlMs: 60_000 });
  const second = await readGpuTelemetry({ cacheTtlMs: 60_000 });
  expect(second.collected_at).toBe(first.collected_at); // cache hit
  const fresh = await readGpuTelemetry({ cacheTtlMs: 60_000, forceRefresh: true });
  expect(fresh.collected_at >= first.collected_at).toBe(true);
  // Forma valida en hosts con o sin GPU (degradacion segura).
  if (!first.available) {
    expect(first.provider).toBe("none");
    expect(first.gpus).toEqual([]);
  }
}, 15_000);

test("readGpuTelemetry detecta GPU NVIDIA real si el host tiene nvidia-smi", async () => {
  const snap = await readGpuTelemetry({ cacheTtlMs: 0, forceRefresh: true });
  if (!snap.available) return; // host sin GPU: la degradacion ya se probo arriba
  expect(snap.provider).toBe("nvidia-smi");
  expect(snap.gpus.length).toBeGreaterThan(0);
  expect(snap.gpus[0].name.trim().length).toBeGreaterThan(0);
  expect(snap.gpus[0].vram_total_mb).toBeGreaterThan(0);
}, 15_000);

// ---------------------------------------------------------------------------
// exec-win (solo Windows)
// ---------------------------------------------------------------------------
test.skipIf(!ON_WINDOWS)("exec-win: argv binario ejecuta y escribe stdout.log", async () => {
  const req = jobRequest({ argv: ["cmd.exe", "/d", "/s", "/c", "echo hola-win"] });
  const handle = await winComputeExecutor.spawn(req);
  const result = await handle.done;
  expect(result.exit_code).toBe(0);
  expect(result.timed_out).toBe(false);
  expect(result.killed).toBe(false);
  expect(existsSync(req.stderr_path)).toBe(true);
  expect(readFileSync(req.stdout_path, "utf8")).toContain("hola-win");
});

test.skipIf(!ON_WINDOWS)("exec-win: command de shell via cmd /d /s /c y env sanitizado inyectado", async () => {
  const req = jobRequest({
    command: "echo %ISYMCP_E2E_VAR%",
    env: { ISYMCP_E2E_VAR: "inyectada" },
  });
  const handle = await winComputeExecutor.spawn(req);
  const result = await handle.done;
  expect(result.exit_code).toBe(0);
  expect(readFileSync(req.stdout_path, "utf8")).toContain("inyectada");
});

test.skipIf(!ON_WINDOWS)("exec-win: prioridad idle se aplica al proceso (os.setPriority)", async () => {
  const req = jobRequest({ argv: ["cmd.exe", "/d", "/s", "/c", "ping -n 5 127.0.0.1 > nul"], priority: "idle" });
  const handle = await winComputeExecutor.spawn(req);
  expect(os.getPriority(handle.pid)).toBe(os.constants.priority.PRIORITY_LOW);
  handle.cancel();
  await handle.done;
});

test.skipIf(!ON_WINDOWS)("exec-win: timeout expira, cancela y reporta timed_out", async () => {
  const req = jobRequest({
    argv: ["cmd.exe", "/d", "/s", "/c", "ping -n 15 127.0.0.1 > nul"],
    timeout_ms: 700,
  });
  const handle = await winComputeExecutor.spawn(req);
  const result = await handle.done;
  expect(result.timed_out).toBe(true);
  expect(result.killed).toBe(true);
}, 10_000);

test.skipIf(!ON_WINDOWS)("exec-win: cancel mata el arbol completo (hijo que spawnea nieto)", async () => {
  const marker = `ISYMCP-TREEKILL-${Date.now()}`;
  const script = `Start-Process cmd -WindowStyle Hidden -ArgumentList '/k','echo ${marker}'; Start-Sleep 30`;
  const req = jobRequest({ argv: ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script] });
  const handle = await winComputeExecutor.spawn(req);
  await new Promise((r) => setTimeout(r, 1500)); // deja nacer hijo + nieto
  expect(processMatchesTable([marker])).toEqual([true]);
  await handle.cancel();
  const result = await handle.done;
  expect(result.killed).toBe(true);
  await new Promise((r) => setTimeout(r, 1200));
  // Si el nieto sobreviviera, el marcador seguiria apareciendo en alguna linea de comando.
  expect(processMatchesTable([marker])).toEqual([false]);
}, 20_000);

// ---------------------------------------------------------------------------
// exec-wsl (solo Windows con WSL instalado; skip limpio si no)
// ---------------------------------------------------------------------------
test.skipIf(!wslAvailable)("exec-wsl: echo con argv y espacios en el argumento sobrevive a wsl.exe", async () => {
  const req = jobRequest({
    target: "wsl",
    argv: ["echo", "hola wsl con espacios"],
    cwd: wslTestCwd,
  });
  const handle = await wslComputeExecutor.spawn(req);
  const result = await handle.done;
  expect(result.exit_code).toBe(0);
  expect(readFileSync(req.stdout_path, "utf8")).toContain("hola wsl con espacios");
}, 30_000);

test.skipIf(!wslAvailable)("exec-wsl: command via bash -lc con export de entorno", async () => {
  const req = jobRequest({
    target: "wsl",
    command: "echo $ISYMCP_WSL_VAR",
    env: { ISYMCP_WSL_VAR: "export-funciona" },
    cwd: wslTestCwd,
  });
  const handle = await wslComputeExecutor.spawn(req);
  const result = await handle.done;
  expect(result.exit_code).toBe(0);
  expect(readFileSync(req.stdout_path, "utf8")).toContain("export-funciona");
}, 30_000);

test.skipIf(!wslAvailable)("exec-wsl: cancel mata el proceso dentro de WSL y el wrapper", async () => {
  const req = jobRequest({
    target: "wsl",
    argv: ["sleep", "30"],
    cwd: wslTestCwd,
  });
  const handle = await wslComputeExecutor.spawn(req);
  await new Promise((r) => setTimeout(r, 1200)); // deja que setsid escriba linux.pid
  await handle.cancel();
  const result = await handle.done;
  expect(result.killed).toBe(true);
}, 30_000);

test.skipIf(!wslAvailable)("exec-wsl: cwd Windows traducido corre en drvfs o falla controlado (exit 66)", async () => {
  const req = jobRequest({
    target: "wsl",
    argv: ["pwd"],
    cwd: tmpdir(), // ruta Windows: ejecuta en drvfs o debe fallar con exit 66
  });
  const handle = await wslComputeExecutor.spawn(req);
  const result = await handle.done;
  if (wslSeesWindowsDrives) {
    expect(result.exit_code).toBe(0);
    expect(readFileSync(req.stdout_path, "utf8").toLowerCase()).toContain("/mnt/");
  } else {
    expect(result.exit_code).toBe(66);
    expect(readFileSync(req.stderr_path, "utf8")).toContain("cwd WSL inaccesible");
  }
}, 30_000);

test.skipIf(!ON_WINDOWS)("exec-win: max_log_bytes trunca con aviso y el hijo termina (sin bloqueo de pipe)", async () => {
  const req = jobRequest({
    argv: ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "1..20000 | % { 'x' * 100 }"],
    max_log_bytes: 4096,
  });
  const handle = await winComputeExecutor.spawn(req);
  const result = await handle.done;
  expect(result.exit_code).toBe(0);
  const log = readFileSync(req.stdout_path, "utf8");
  expect(log).toContain("[isymcp] output truncated at 4096 bytes");
  expect(Buffer.byteLength(log)).toBeLessThan(4096 + 200);
}, 30_000);
