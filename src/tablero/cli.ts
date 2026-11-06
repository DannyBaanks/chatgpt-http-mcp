// cli.ts — `isymcp tablero <init|status|on|off|stop>`: el interruptor humano.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { securePrivatePath } from "../platform/private-path";
import { loadTableroConfig, TableroConfigError, tableroConfigPath } from "./config";
import { TableroService } from "./service";

const TEMPLATE = {
  enabled: false,
  tableroDir: "/ruta/absoluta/al/chat_sandbox (contiene tablero.py y chat.py)",
  identity: "gpt_mano_derecha",
  allowedRoots: [],
  maxLive: 2,
  maxPerHour: 6,
  passEnv: [],
  launchers: {},
  _ejemplo_launcher: { argv: ["/ruta/absoluta/al/agente", "{prompt}"], cwd: "/ruta/dentro/de/allowedRoots" },
};

function writePrivate(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  securePrivatePath(path, false);
}

function setEnabled(enabled: boolean): number {
  const path = tableroConfigPath();
  if (!existsSync(path)) {
    console.error(`no existe ${path}. Crea la plantilla con: isymcp tablero init`);
    return 1;
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  raw.enabled = enabled;
  writePrivate(path, raw);
  if (!enabled) {
    console.log(`tablero APAGADO (${path}). Las tools tablero_* responden tablero_disabled desde ya.`);
    console.log("Las consolas ya lanzadas siguen vivas; para cerrarlas: isymcp tablero stop");
    return 0;
  }
  try {
    const cfg = loadTableroConfig(path);
    console.log(`tablero ENCENDIDO como ${cfg.identity}; lanzables: ${Object.keys(cfg.launchers).join(", ") || "(ninguno)"}`);
    return 0;
  } catch (error) {
    raw.enabled = false;
    writePrivate(path, raw);
    console.error(`no se enciende: ${(error as Error).message}`);
    return 1;
  }
}

export function tableroCommand(sub: string): number {
  const path = tableroConfigPath();
  if (sub === "init") {
    if (existsSync(path)) {
      console.error(`ya existe ${path}; no lo sobrescribo`);
      return 1;
    }
    writePrivate(path, TEMPLATE);
    console.log(`plantilla creada (apagada, 0600): ${path}`);
    console.log("Edita tableroDir, allowedRoots y launchers; luego: isymcp tablero on");
    return 0;
  }
  if (sub === "on") return setEnabled(true);
  if (sub === "off") return setEnabled(false);
  const service = new TableroService();
  if (sub === "stop") {
    // Freno de emergencia: no lee tablero.json, funciona apagado o con la config rota.
    let closed: string[];
    try {
      closed = service.stopAll();
    } catch (error) {
      console.error(`stop: ${(error as Error).message}`);
      return 1;
    }
    console.log(closed.length ? `cerradas: ${closed.join(", ")}` : "no habia consolas del Tablero");
    return 0;
  }
  if (sub === "status") {
    try {
      const cfg = loadTableroConfig(path);
      console.log(`ENCENDIDO · identidad ${cfg.identity} · ${path}`);
      console.log(`tablero: ${cfg.tableroDir}`);
      console.log(`límites: ${cfg.maxLive} consolas vivas, ${cfg.maxPerHour} lanzamientos/hora`);
      for (const [name, l] of Object.entries(cfg.launchers)) console.log(`  ${name}: ${l.argv.join(" ")}  (cwd ${l.cwd})`);
      const consoles = service.consoles();
      console.log(consoles.length ? "consolas vivas:" : "consolas vivas: ninguna");
      for (const c of consoles) console.log(`  ${c.session} · ${c.attach}`);
      return 0;
    } catch (error) {
      if (error instanceof TableroConfigError) {
        console.log(`${error.code === "tablero_disabled" ? "APAGADO" : error.code === "tablero_not_configured" ? "SIN CONFIGURAR" : "CONFIG INVÁLIDA"}: ${
          error.message}`);
        return error.code === "tablero_config_invalid" ? 1 : 0;
      }
      throw error;
    }
  }
  console.error("uso: isymcp tablero <init|status|on|off|stop>");
  return 2;
}
