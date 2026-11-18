import { VIEWS, type ViewId } from "./types";

export type CommandAction = {
  kind: "command";
  key: string;
  args: string[];
  label: string;
  confirm?: string;
  /** Lleva a la vista Salida al terminar (paleta). */
  toOutput?: boolean;
};

export type BatchAction = { kind: "batch"; label: string; confirm: string; steps: string[][] };

export type DashAction =
  | CommandAction
  | BatchAction
  | { kind: "key"; key: string; label: string }
  | { kind: "view"; view: ViewId }
  | { kind: "nextView"; dir: 1 | -1 }
  | { kind: "move"; delta: number }
  | { kind: "toggleDetail" }
  | { kind: "logsFor"; filter: string }
  | { kind: "cycleLogSource" }
  | { kind: "toggleNoise" }
  | { kind: "startInput"; mode: "palette" | "filter" }
  | { kind: "open"; url: string }
  | { kind: "note"; text: string }
  | { kind: "help" }
  | { kind: "exit" };

export type Confirmable = CommandAction | BatchAction;

const commandActions: Record<string, CommandAction> = {
  u: { kind: "command", key: "u", args: ["up"], label: "up" },
  d: { kind: "command", key: "d", args: ["down"], label: "down", confirm: "Detener server y túnel" },
  t: { kind: "command", key: "t", args: ["tunnel", "connect"], label: "tunnel connect" },
  T: { kind: "command", key: "T", args: ["tunnel", "stop"], label: "tunnel stop" },
  p: { kind: "command", key: "p", args: ["panel", "start"], label: "panel start" },
  P: { kind: "command", key: "P", args: ["panel", "stop"], label: "panel stop" },
  o: { kind: "command", key: "o", args: ["panel"], label: "abrir panel" },
  m: { kind: "command", key: "m", args: ["monitor", "start"], label: "monitor start" },
  M: { kind: "command", key: "M", args: ["monitor", "stop"], label: "monitor stop" },
  r: { kind: "command", key: "r", args: ["hub", "reload"], label: "hub reload", confirm: "Recargar hub (SIGHUP reinicia todos los MCP de todas las TUIs)" },
  c: { kind: "command", key: "c", args: ["canary"], label: "canary" },
  D: { kind: "command", key: "D", args: ["doctor"], label: "doctor" },
  s: { kind: "command", key: "s", args: ["allow", "once", "shell"], label: "allow once shell", confirm: "Permitir un uso de shell" },
  a: { kind: "command", key: "a", args: ["allow", "once", "agents"], label: "allow once agents", confirm: "Permitir un uso de agents" },
  S: { kind: "command", key: "S", args: ["allow", "shell", "off"], label: "allow shell off" },
  A: { kind: "command", key: "A", args: ["allow", "agents", "off"], label: "allow agents off" },
  x: { kind: "command", key: "x", args: ["taint", "clear"], label: "taint clear", confirm: "Limpiar taint" },
  R: {
    kind: "command",
    key: "R",
    args: ["systemctl", "--user", "restart", "isymcp-hub"],
    label: "reiniciar hub",
    confirm: "Reiniciar hub; corta la conexión MCP de todas las TUIs",
  },
};

/** Teclas globales (las de vista se resuelven antes en ops.viewKeyAction). */
export function keyToAction(key: string): DashAction | null {
  if (key === "q" || key === "ctrl-c") return { kind: "exit" };
  if (key === "?") return { kind: "help" };
  if (key === "l") return { kind: "view", view: "logs" };
  if (key === ":") return { kind: "startInput", mode: "palette" };
  if (key === "tab") return { kind: "nextView", dir: 1 };
  if (key === "backtab") return { kind: "nextView", dir: -1 };
  if (key === "up" || key === "k") return { kind: "move", delta: -1 };
  if (key === "down" || key === "j") return { kind: "move", delta: 1 };
  if (key === "pageup") return { kind: "move", delta: -10 };
  if (key === "pagedown") return { kind: "move", delta: 10 };
  if (key === "home" || key === "g") return { kind: "move", delta: -1_000_000 };
  if (key === "end" || key === "G") return { kind: "move", delta: 1_000_000 };
  const n = Number(key);
  if (Number.isInteger(n) && n >= 1 && n <= VIEWS.length) return { kind: "view", view: VIEWS[n - 1]! };
  return commandActions[key] ?? null;
}

export function commandForKey(key: string): CommandAction | null {
  return commandActions[key] ?? null;
}

/** Solo la tecla minúscula `y` confirma; cualquier otra entrada cancela. */
export function confirmationDecision(key: string): "confirm" | "cancel" {
  return key === "y" ? "confirm" : "cancel";
}

export function resolveConfirmation<T extends Confirmable>(action: T, key: string): T | null {
  return confirmationDecision(key) === "confirm" ? action : null;
}

export function confirmationText(action: Confirmable): string | null {
  return action.confirm ?? null;
}

export function allCommandActions(): CommandAction[] {
  return Object.values(commandActions);
}

/** Teclas de servicio: valen en todas las vistas. */
export function keyLegend(): string {
  return "u up · d down · t/T túnel · p/P panel · o abrir · m/M monitor · c canary · D doctor · s/a once · S/A off · x taint · r reload · R restart hub · : comando · ? ayuda · q salir";
}

/** Teclas propias de cada vista. */
export function viewLegend(view: ViewId): string {
  const nav = "1-6/Tab vista · ↑↓ mover";
  switch (view) {
    case "resumen": return `${nav} · Enter arreglar la alerta`;
    case "hub": return `${nav} · Enter detalle · K reiniciar este MCP · L su log`;
    case "tareas": return `${nav} · Enter detalle · O abrir conversación · Y aprobar (monitor)`;
    case "sesiones": return `${nav} · X revocar · C revocar caducadas`;
    case "logs": return `${nav}/PgUp · F fuente · / filtrar · H ruido de sondeo`;
    case "salida": return `${nav}/PgUp · salida completa de los últimos comandos`;
  }
}
