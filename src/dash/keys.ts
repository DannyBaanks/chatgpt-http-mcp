export type CommandAction = {
  kind: "command";
  key: string;
  args: string[];
  label: string;
  confirm?: string;
};

export type DashAction = CommandAction | { kind: "logs" } | { kind: "help" } | { kind: "exit" };

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

export function keyToAction(key: string): DashAction | null {
  if (key === "q" || key === "ctrl-c") return { kind: "exit" };
  if (key === "l") return { kind: "logs" };
  if (key === "?") return { kind: "help" };
  return commandActions[key] ?? null;
}

/** Solo la tecla minúscula `y` confirma; cualquier otra entrada cancela. */
export function confirmationDecision(key: string): "confirm" | "cancel" {
  return key === "y" ? "confirm" : "cancel";
}

export function resolveConfirmation(action: CommandAction, key: string): CommandAction | null {
  return confirmationDecision(key) === "confirm" ? action : null;
}

export function confirmationText(action: CommandAction): string | null {
  return action.confirm ?? null;
}

export function allCommandActions(): CommandAction[] {
  return Object.values(commandActions);
}

export function keyLegend(): string {
  return "u up · d down · t/T túnel · p/P panel · o abrir · m/M monitor · r reload · c canary · D doctor · s/a once · S/A off · x taint · R restart · l log · ? ayuda · q salir";
}
