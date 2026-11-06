import { expect } from "bun:test";
import { statSync } from "node:fs";

/**
 * Verifica la intencion privada 0700/0600 del repo como la expresa la
 * plataforma actual: modo POSIX en Unix, icacls en Windows. En Windows un
 * camino privado tiene exactamente 3 ACEs plenos (dueno, SYSTEM,
 * Administradores), explicitas o heredadas del directorio padre; los hijos
 * heredan la ACL del directorio, por eso `(I)` es valido. Nombres de grupo
 * localizados no importan.
 */
export function expectPrivate(path: string, directory: boolean): void {
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(directory ? 0o700 : 0o600);
    return;
  }
  const icacls = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\icacls.exe`;
  const probe = Bun.spawnSync([icacls, path], { stdout: "pipe", stderr: "ignore" });
  expect(probe.exitCode).toBe(0);
  const aces = probe.stdout.toString().split(/\r?\n/).map((line) => line.trim()).filter((line) => line.includes(":("));
  expect(aces.length).toBe(3);
  for (const ace of aces) {
    const tokens = ace.slice(ace.indexOf(":(")).match(/\([^)]+\)/g)!.map((t) => t.slice(1, -1));
    expect(tokens.at(-1)).toBe("F");
    for (const token of tokens.slice(0, -1)) expect(["OI", "CI", "I", "ID", "IO"]).toContain(token);
    if (directory) {
      expect(tokens).toContain("OI");
      expect(tokens).toContain("CI");
    }
  }
}
