// src/control-center/contracts.ts — Tipos y contratos para el ISyMCP Control Center.

import type { TaskState } from "../remote-monitor";

export interface ServiceHealthItem {
  id: string;
  name: string;
  status: "up" | "down" | "ready" | "stopped" | "warn";
  detail: string;
  endpoint?: string;
  pid?: number | null;
}

export interface ControlCenterOverview {
  ts: string;
  services: ServiceHealthItem[];
  monitor: {
    status: "up" | "down";
    url: string;
    pid: number | null;
    activeLeasesCount: number;
    totalTasksCount: number;
    unackedTasksCount: number;
  };
  bridge: {
    port: string;
    status: "up" | "down";
    auth: "ok" | "token_required";
    tunnel: "ready" | "stopped";
    activeBroker: boolean;
  };
  metrics?: {
    memoryRssMb: number;
    uptimeSeconds: number;
    loadAvg?: number[];
  } | null;
}

export interface ControlCenterTaskItem {
  task_id: string;
  operation_id: string;
  workspace_id: string;
  kind: string;
  description: string;
  state: TaskState;
  requested_actions: string[];
  attempt_count: number;
  created_at: number;
  updated_at: number;
  has_receipt: boolean;
  receipt_hmac?: string | null;
  result_summary?: string | null;
  exit_code?: number | null;
}

export interface ControlCenterDispatchRequest {
  action: string;
  arguments?: Record<string, unknown>;
  confirmed?: boolean;
}

export interface ControlCenterDispatchResponse {
  ok: boolean;
  action: string;
  result?: unknown;
  error?: string;
  requires_confirmation?: boolean;
  warning?: string;
}
