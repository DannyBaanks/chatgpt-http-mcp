// Shared notice contract: producers keep evidence; presentation stays concise.
export type NoticeSeverity = "info" | "warn" | "error" | "action_required";
export interface Notice {
  kind: "NOTICE";
  severity: NoticeSeverity;
  source: string;
  component: string;
  event: string;
  summary: string;
  evidence_ref: string;
  action?: string;
}

export function desktopNotice(notice: Notice): { title: string; body: string } {
  const labels: Record<NoticeSeverity, string> = { info: "Informacion", warn: "Aviso", error: "Error", action_required: "Requiere accion" };
  return {
    title: `${notice.source.toUpperCase()} · ${labels[notice.severity]}`,
    body: `Origen: ${notice.component}\nEvento: ${notice.event}\n${notice.summary}\n${notice.action ? `Detalle: ${notice.action}` : `Evidencia: ${notice.evidence_ref}`}`,
  };
}
