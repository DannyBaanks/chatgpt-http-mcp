// src/cli/help.ts — Ayuda global de `isymcp` (movida de isymcp.ts).
import { ask } from "../cli/args";
import { visible } from "../menu";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PID, alive, tunnel } from "./services";
import { command } from "./commands/codex";
import { status } from "./commands/status";
import { logs } from "./commands/logs";
import { ROOT } from "./root";

export function help(): void {
  console.log(`isymcp v${JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version} — consola del bridge Codex ISyMCP

  isymcp                     menu interactivo con todo (en una terminal);
                             sin terminal (pipe/script) imprime el estado
  isymcp status              estado: server, tunel, panel, ChatGPT, canario
  isymcp menu [id]           menu (o una rama/accion: isymcp menu harness)

  isymcp panel               abre el panel :8798 (lo levanta detached si hace falta)
  isymcp panel control-center abre directamente la vista del Control Center
  isymcp ui | control-center interfaz gráfica web: catálogo CLI, monitor, AGY TUI y suites
  isymcp panel start|stop|status
  isymcp panel run [--port 8798]   panel en primer plano (Ctrl+C)
  isymcp monitor start|stop|status monitor residente continuo en background (no se cierra hasta stop)
  isymcp monitor run [--port 8799] monitor continuo en primer plano (Ctrl+C para matar)
  isymcp monitor lease mint --workspace <id> --cwd <dir> [--ttl-seconds 7200] [--auto-grant]
  isymcp monitor lease renew <lease-id> --ttl-seconds <seg>
  isymcp monitor lease revoke <lease-id>
  isymcp monitor approve <task-id>
  isymcp monitor tasks             lista las tareas encoladas y sus respuestas/estados
  isymcp protocol                  imprime el protocolo oficial de coordinacion y bootstrap de agentes
  isymcp exec "<comando>"          ejecuta un comando bash arbitrario con persistencia de cwd
  isymcp github [cmd]              suite de GitHub: tokens con TTL en horas, asistente
                                   wizard interactivo, API REST y GitHub Actions
  isymcp ask "texto" [--new] turno real con ChatGPT desde la terminal; sigue
                             el mismo chat (visible en el panel); --new abre otro.
                             Tambien por stdin: echo hola | isymcp ask
  isymcp up [--no-connector] levanta server (detached) y conecta el tunel;
                             no toca ~/.codex/config.toml. Para enrutarlo ahi:
                             isymcp models apply, o usa isymcp codex
  isymcp down                para server y tunel
  isymcp server start|stop
  isymcp tunnel setup        abre ajustes de OpenAI, guarda ID/API key y conecta
  isymcp tunnel connect|stop|status
  isymcp native-browser status|probe [--json] diagnostico del navegador nativo
  isymcp ask "texto" --browser native seleccion explicita; falla si no esta disponible
  isymcp models              dry-run del perfil Web privado
  isymcp models apply        prepara perfil aislado; no cambia Codex global
  isymcp models restore      restaura solo el perfil Web propio
  isymcp codex [args...]     ejecuta Codex con perfil ISyMCP aislado (sin mutar config.toml)
  isymcp conversation new [--client cli] [--cwd dir] [--model alias]
                             CLI interactivo, proveedor solo de ese proceso.
  isymcp conversation list   hilos confirmados, con id completo
  isymcp conversation resume <launch-id|thread-id>
  isymcp version             imprime la versión instalada
  isymcp codex launcher      instala lanzador ~/.local/bin/codex-isymcp y .desktop
                             es un CLI en terminal, no la app de Codex
  isymcp command "texto"     texto para pegar en chatgpt.com
  isymcp media prepare      pega una URL, elige carpeta y confirma el paquete
  isymcp media prepare <url> prepara de forma no interactiva y devuelve JSON
  isymcp media transcribe <id> transcribe subtítulos y habla con marcas de tiempo
  isymcp media search <id> <q> busca coincidencias temporales exactas en la transcripción
  isymcp media vmm <id>     genera el Video Multimodal Manifest (timeline de keyframes + voz)
  isymcp comfy workflow add <workflow.json> registra un workflow API local de ComfyUI
  isymcp comfy workflow list lista los workflows registrados
  isymcp comfy status         comprueba la instancia local de ComfyUI
  isymcp tablero status      estado del grupo tablero_* (apagado por defecto)
  isymcp tablero init|on|off plantilla / encender / apagar al instante
  isymcp tablero stop        cierra todas las consolas lanzadas desde el Tablero
  isymcp tui list            TUIs detectadas (config dir y/o binario)
  isymcp tui install [--all | <tui>]  dry-run de instalación de MCP en TUIs
  isymcp tui install [--all | <tui>] --apply  escribe configs con backup (gemini, claude, cursor, opencode, etc.)
  isymcp tui install [--all | <tui>] --restore vuelve al backup anterior
  isymcp tui spawn "<prompt>" [--agent id] [--title t] [--mode auto] [--dry-run]  abre consola de agente (agy, claude, opencode, openisy, codex, gemini...)
  isymcp tui agents          agentes lanzables y cómo les llegan las tareas
  isymcp monitor ack <task> --console <con-id> [--summary s]   ACK de consola (no cierra la tarea; token en $ISYMCP_ACK_TOKEN)
  isymcp monitor respond <task> --console <con-id> --progress|--complete|--fail --summary s
  isymcp monitor consoles [--json]  consolas TUI: console_id, PID real de agy, alive, token_fp, estado
  isymcp monitor console-log <con-id|task-id> [--tail N]  log cronológico de una consola
  isymcp monitor wait-next [segundos] [--console id] espera síncronamente la próxima tarea de ChatGPT
  isymcp monitor respond <id> --summary "..." [--wait] confirma recepción/resultado de tarea
  isymcp monitor alert [--title t] [--summary s] [--source src] encola una alerta o webhook reactivo
  isymcp github watch-ci [run_id|pr] [--detach] despierta un proceso hijo para alertar al monitor al concluir el CI
  isymcp exec "<comando>" [--cwd dir] ejecuta comando shell con CWD persistente
  isymcp fuzz [iteraciones]  ejecuta la suite de fuzzing adversarial (configs TUI y MCP Gateway)
  isymcp session mint --cwd <dir> [--label x] [--write] [--ttl horas] [--request-file TASK.md]
                             crea un session token del MCP (read-only por defecto;
                             caduca a las 24 h, --ttl 0 = nunca;
                             request-file vincula una tarea local por SHA-256)
  isymcp session list        sesiones vivas (solo fingerprint)
  isymcp session revoke <token|fp>
  isymcp canary              turno real de prueba (eco A, eco B sin A, markdown)
  isymcp canary status       ultimo resultado
  isymcp canary schedule [--apply]   programacion diaria (systemd / Task Scheduler; sin --apply: solo muestra)
  isymcp canary unschedule [--apply]
  isymcp allow [status]      permisos del operador para lo que ejecuta código (cerrados por defecto)
  isymcp allow shell on|off  shell_exec en el host sin sandbox
  isymcp allow agents on|off abrir consolas de agentes y pegarles tareas desde ChatGPT
                             on caduca a las 12 h; --for 30m|2h|1d (máx 24h) o --forever
  isymcp allow log [--last N] bitácora de las puertas: qué se permitió/denegó, cuándo y por qué
  isymcp harness list [--server chatgpt|gateway|all]  CLIs/TUIs de agentes detectadas + si tienen el MCP
  isymcp harness install <ids|--all> [--server chatgpt|gateway|all] [--apply]
                             chatgpt = isymcp-chatgpt, gateway = isymcp completo (sin --apply: solo el plan)
  isymcp harness uninstall <ids|--all> [--server chatgpt|gateway|all] [--apply]
  isymcp health              diagnóstico de salud en vivo del bridge y servicios
  isymcp doctor              diagnóstico local: binarios, sandbox, disco, último fallo de media
  isymcp doctor --json       el mismo reporte en JSON (códigos de error incluidos)
  isymcp doctor --explain    añade una explicación con un modelo local (opt-in; no ejecuta nada)
  isymcp doctor --fix <id> [--apply]  plan (dry-run) o aplica un remedio whitelisted
  isymcp metrics             telemetría en vivo (turnos, tokens, latencias, memoria)
  isymcp metrics --prom      métricas en formato Prometheus / OpenMetrics
  isymcp smoke               batería de pruebas E2E automatizada (health, métricas, harnesses, launcher)
  isymcp logs                ultimos 50
  isymcp logs --last 20
  isymcp logs export         guarda TODOS en ~/.codex-web-http/logs/
  isymcp logs export --since 2026-10-02T16:00 --until 2026-10-02T17:00
  isymcp logs export --out /tmp/isymcp.log

Cerrar esta terminal no mata nada: server y panel quedan detached.
`);
}
