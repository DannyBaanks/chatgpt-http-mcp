// src/cli/commands/phone.ts — `isymcp phone ...`: la API de la app del celular (solo por Tailscale).
import type { CliModule } from "../module";
import { flag } from "../args";
import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUN, alive, readPid } from "../services";
import { ROOT } from "../root";
import { stopProcessTree } from "../../platform/process";

const PHONE_PID = join(RUN, "phone.pid");
const PHONE_LOG = join(RUN, "phone.log");

async function phoneUrl(port: number): Promise<string | null> {
  const { tailscaleIPv4 } = await import("../../phone/auth");
  const ip = await tailscaleIPv4();
  return ip ? `http://${ip}:${port}` : null;
}

async function phoneUp(port: number): Promise<boolean> {
  const url = await phoneUrl(port);
  if (!url) return false;
  try {
    const res = await fetch(`${url}/v1/hello`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

const USAGE = `uso:
  isymcp phone start|stop|status       API para la app del celular (solo en la IP de Tailscale, :8797)
  isymcp phone serve [--port N]        lo mismo en primer plano
  isymcp phone pair                    código de un solo uso (5 min) para emparejar la app
  isymcp phone devices                 celulares emparejados
  isymcp phone revoke <device_id>      quitarle el acceso a un celular`;

export const phoneModule: CliModule = {
  names: ["phone"],
  async run(sub, rest) {
    const port = Number(flag("--port", rest) ?? process.env.ISYMCP_PHONE_PORT ?? "8797");
    const D = await import("../../phone/devices");

    if (sub === "serve") {
      const { startPhoneServer } = await import("../../phone/server");
      const s = await startPhoneServer({ port });
      console.log(`API del celular en ${s.url} (solo Tailscale; peticiones firmadas)`);
      await new Promise(() => {});
      return;
    }
    if (sub === "start") {
      if (await phoneUp(port)) {
        console.log(`la API del celular ya corre en ${await phoneUrl(port)}`);
        return;
      }
      if (!(await phoneUrl(port))) {
        console.error("✗ Tailscale no tiene IPv4 aquí: conéctalo (tailscale up) y reintenta");
        process.exitCode = 1;
        return;
      }
      mkdirSync(RUN, { recursive: true });
      const logFd = openSync(PHONE_LOG, "a");
      const child = spawn("bun", ["run", join(ROOT, "src", "isymcp.ts"), "phone", "serve", "--port", String(port)], {
        cwd: ROOT, detached: true, stdio: ["ignore", logFd, logFd],
      });
      child.unref();
      writeFileSync(PHONE_PID, `${child.pid}\n`);
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (await phoneUp(port)) {
          console.log(`API del celular detached pid=${child.pid} ${await phoneUrl(port)} log=${PHONE_LOG}`);
          return;
        }
      }
      console.error(`✗ la API del celular no respondió en 5 s; mira ${PHONE_LOG}`);
      process.exitCode = 1;
      return;
    }
    if (sub === "stop") {
      const pid = readPid(PHONE_PID);
      if (pid && alive(pid)) {
        stopProcessTree(pid);
        console.log(`API del celular parada (pid ${pid})`);
      } else console.log("la API del celular no estaba corriendo");
      try { writeFileSync(PHONE_PID, ""); } catch { /* opcional */ }
      return;
    }
    if (!sub || sub === "status") {
      const up = await phoneUp(port);
      console.log(`  ${up ? "● corriendo" : "○ parada  "}  API del celular ${(await phoneUrl(port)) ?? "(Tailscale sin IPv4)"}`);
      const devs = D.listDevices();
      console.log(`  ${devs.length} celular(es) emparejado(s)${devs.length ? ": " + devs.map((d) => d.name).join(", ") : ""}`);
      return;
    }
    if (sub === "pair") {
      const url = await phoneUrl(port);
      if (!url) {
        console.error("✗ Tailscale no tiene IPv4 aquí: conéctalo (tailscale up) y reintenta");
        process.exitCode = 1;
        return;
      }
      const { code, expires_at } = D.createPairingCode();
      console.log(`  servidor: ${url}`);
      console.log(`  código:   ${code}    (un solo uso; caduca a las ${new Date(expires_at).toLocaleTimeString()})`);
      console.log("  En la app: Emparejar > escribe servidor y código > confirma con Face ID.");
      if (!(await phoneUp(port))) console.log("  ojo: la API está parada; arráncala con: isymcp phone start");
      return;
    }
    if (sub === "devices") {
      const devs = D.listDevices();
      if (rest.includes("--json")) { console.log(JSON.stringify(devs.map(({ read_key, approve_key, ...d }) => d), null, 2)); return; }
      if (!devs.length) console.log("  (ningún celular emparejado: isymcp phone pair)");
      for (const d of devs) console.log(`  ${d.id}  ${d.name.padEnd(20)} emparejado ${d.paired_at.slice(0, 16).replace("T", " ")}  visto ${d.last_seen ? d.last_seen.slice(0, 16).replace("T", " ") : "-"}`);
      return;
    }
    if (sub === "revoke") {
      const id = rest[0];
      if (!id) { console.error("✗ uso: isymcp phone revoke <device_id> (míralo con isymcp phone devices)"); process.exit(2); }
      const ok = D.revokeDevice(id);
      const { appendAudit } = await import("../../permissions");
      if (ok) appendAudit({ action: "phone revoke", decision: "operator", source: "cli", device: id });
      console.log(ok ? `  ✓ ${id} ya no tiene acceso` : `  (no existe ${id})`);
      return;
    }
    console.error(USAGE);
    process.exit(2);
  },
};
