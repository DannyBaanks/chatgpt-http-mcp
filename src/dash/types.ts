export interface StatusJson {
  version: string;
  ts: string;
  server: { up: boolean; url: string; pid: number | null; log: string };
  tunnel: { ready: boolean; running: boolean | null; state: string };
  mcp: { up: boolean };
  connector: string;
  conversation: string | null;
  sessions: Array<{ label: string; fp: string; writable: boolean; expired: boolean; expiresAt?: string | null; cwd?: string }>;
  panel: { up: boolean; url: string };
  monitor: { up: boolean; url: string; pid: number | null };
  chatgpt: string | null;
  canary: { ok: boolean; ts: string } | null;
  tasks: { total: number; blocked: number; items?: TaskItem[] } | null;
  gates: {
    shell: { on: boolean; expires: string | null };
    agents: { on: boolean; expires: string | null };
  };
  taint: { tainted: boolean; until: string | null };
}

/** Tarea de Codex (codex-tasks.ts): solo metadatos, nunca el transcript. */
export interface TaskItem {
  id: string;
  conversation: string | null;
  turns: number;
  updated: string;
  state: string;
}

export interface HubInstance {
  id: string;
  pid: number | null;
  state: string;
  client?: string;
  in_flight?: number;
  ready_ms?: number;
}

export interface HubServer {
  server: string;
  isolation: string;
  enabled: boolean;
  state: string;
  tools: number | string[];
  description?: string;
  serverInfo?: unknown;
  error?: string;
  instances: HubInstance[];
}

export interface HubJson {
  servers: HubServer[];
}

/** Tarea del buzón del monitor (`isymcp monitor tasks --json`). */
export interface MonitorTask {
  task_id: string;
  state: string;
  workspace_id: string;
  kind: string;
  description: string;
  requested_actions?: string[];
  attempt_count?: number;
  updated_at?: number;
  result?: { exit_code?: number | null; output_summary?: string | null } | null;
}

export type LogSource = "hub" | "server" | "tunnel";

export interface DashProvider {
  status(): Promise<StatusJson | null>;
  hub(): Promise<HubJson | null>;
  run(args: string[], timeoutMs?: number): Promise<{ code: number; out: string }>;
  /** Opcionales: sin ellos la vista correspondiente dice "sin datos". */
  monitorTasks?(): Promise<MonitorTask[] | null>;
  logs?(source: LogSource, maxLines: number): Promise<string[]>;
  open?(url: string): Promise<void>;
}

export const VIEWS = ["resumen", "hub", "tareas", "sesiones", "logs", "salida"] as const;
export type ViewId = (typeof VIEWS)[number];

/** Una ejecución de comando, completa, para la vista Salida. */
export interface CommandOutput {
  ts: number;
  cmd: string;
  code: number;
  ms: number;
  lines: string[];
}

export interface DashState {
  status: StatusJson | null;
  hub: HubJson | null;
  now: number;
  message: string;
  busy: boolean;
  spinner: number;
  showHelp: boolean;
  /** false hasta que termina la primera lectura (evita pintar "hub caído" mientras carga). */
  loaded?: boolean;
  view: ViewId;
  /** Fila seleccionada por vista (en logs/salida: desplazamiento desde el final). */
  cursor: Record<ViewId, number>;
  /** Detalle del elemento seleccionado (hub, tareas). */
  expanded: boolean;
  monitorTasks: MonitorTask[] | null;
  logSource: LogSource;
  logLines: string[];
  logFilter: string;
  /** Oculta las conexiones de sondeo (isymcp-hub-status) del log del hub. */
  hideNoise: boolean;
  outputs: CommandOutput[];
  /** Línea de entrada activa: paleta de comandos (`:`) o filtro de log (`/`). */
  input: { mode: "palette" | "filter"; text: string } | null;
}
