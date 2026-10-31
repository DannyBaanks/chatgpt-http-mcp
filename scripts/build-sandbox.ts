import { join } from "node:path";

const root = join(import.meta.dir, "..");
const image = process.env.CODEX_WEB_HTTP_SANDBOX_IMAGE?.trim() || "isymcp-sandbox:1.0.0";
const proc = Bun.spawnSync([
  "docker", "build", "--tag", image, "--file", join(root, "sandbox", "Dockerfile"), join(root, "sandbox"),
], { stdout: "inherit", stderr: "inherit", timeout: 15 * 60_000 });

if (proc.exitCode !== 0) {
  console.error(`No se pudo construir ${image}; Docker Desktop debe estar iniciado y en modo Linux containers.`);
  process.exit(proc.exitCode ?? 1);
}
console.log(`Sandbox listo: ${image}`);
