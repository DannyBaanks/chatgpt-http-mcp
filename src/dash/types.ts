export interface StatusJson {
  version: string;
  ts: string;
  server: { up: boolean; url: string; pid: number | null; log: string };
  tunnel: { ready: boolean; running: boolean | null; state: string };
  mcp: { up: boolean };
  connector: string;
  conversation: string | null;
  sessions: Array<{ label: string; fp: string; writable: boolean; expired: boolean }>;
  panel: { up: boolean; url: string };
  monitor: { up: boolean; url: string; pid: number | null };
  chatgpt: string | null;
  canary: { ok: boolean; ts: string } | null;
  tasks: { total: number; blocked: number } | null;
  gates: {
    shell: { on: boolean; expires: string | null };
    agents: { on: boolean; expires: string | null };
  };
  taint: { tainted: boolean; until: string | null };
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
  instances: HubInstance[];
}

export interface HubJson {
  servers: HubServer[];
}

export interface DashProvider {
  status(): Promise<StatusJson | null>;
  hub(): Promise<HubJson | null>;
  run(args: string[]): Promise<{ code: number; out: string }>;
}

export interface DashState {
  status: StatusJson | null;
  hub: HubJson | null;
  now: number;
  message: string;
  busy: boolean;
  spinner: number;
  showLog: boolean;
  showHelp: boolean;
  logLines: string[];
  /** false hasta que termina la primera lectura (evita pintar "hub caído" mientras carga). */
  loaded?: boolean;
}
