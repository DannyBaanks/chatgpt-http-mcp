// src/hive/types.ts — Tipos canónicos del sistema Hive headless extraído de isyco-worlds (cero Electron).

export type MessageAct =
  | "request"
  | "inform"
  | "propose"
  | "query"
  | "agree"
  | "refuse"
  | "done";

export interface HiveMessage {
  id: string;
  conversation: string;
  in_reply_to: string | null;
  from: string;
  to: string; // agentId, 'god', 'human', 'broadcast', o 'gpt'
  act: MessageAct;
  subject: string;
  body: string;
  hops: number;
  requires_reply: boolean;
  needs_human: boolean;
  created_at: string;
}

export interface HumanQA {
  q: string;
  a?: string;
  askedAt?: string;
  answeredAt?: string;
  dismissedAt?: string;
}

export interface HiveTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  status: "todo" | "doing" | "blocked" | "done";
  dependsOn: string[];
  priority: number;
  createdAt: string;
  humanQA?: HumanQA[];
  result?: string;
  link?: {
    from_office: string;
    from_name: string;
    origin_ref: string | null;
    external: boolean;
  };
  [extra: string]: unknown;
}

export interface HiveTaskStatusEvent {
  id: string;
  taskId: string;
  title: string;
  status: "blocked" | "done";
  ts: number;
}

export interface AgentMeta {
  id: string;
  name: string;
  provider?: string;
  role?: string;
  capabilities?: string[];
  cwd: string;
  isGod?: boolean;
  isAssistant?: boolean;
}

export interface RegistryAgent extends AgentMeta {
  status: "idle" | "working" | "blocked" | "gone";
  lastSeen: number;
  archived?: boolean;
  onHold?: boolean;
  sessionId?: string;
  cwdValid?: boolean;
}

export interface Registry {
  godId: string | null;
  agents: Record<string, RegistryAgent>;
}

export interface SpawnInjection {
  args: string[];
  env: Record<string, string>;
  systemPrompt: string;
}

export interface HookPayload {
  hook_event_name?: string;
  agent_id?: string | null;
  session_id?: string;
  transcript_path?: string;
  context_window?: {
    total_input_tokens?: number;
    context_window_size?: number;
  };
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  stop_hook_active?: boolean;
  prompt?: string;
  source?: string;
  notification_type?: string;
  message?: string;
}

export interface RouterHealth {
  running: boolean;
  lastRouteAt: number;
  backlog: number;
  oldestBacklogMs: number | null;
}

export const GPT_PRINCIPAL = "gpt";
