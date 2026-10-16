// doctor-explain.ts — M6: explicacion opt-in con un modelo local.
//
// Reglas duras:
//  - NUNCA ejecuta lo que proponga el modelo: solo imprime texto.
//  - El prompt se construye desde el reporte y se SANEA (sin URLs, rutas ni
//    tokens) y se recorta antes de salir del proceso.
//  - Sin motor configurado degrada en silencio: el doctor determinista manda.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { sanitizeMediaDetail } from "./media/error-codes";
import type { DoctorReport } from "./doctor";

export const EXPLAIN_ENV = "ISYMCP_EXPLAIN_CMD";
const MAX_PROMPT = 1200;
const EXPLAIN_TIMEOUT_MS = 20_000;

export type ExplainRunner = (prompt: string) => Promise<string>;

/** Prompt compacto y saneado: solo el estado del entorno y el remedio. */
export function buildExplainPrompt(report: DoctorReport): string {
  const parts: string[] = [
    "Eres un asistente de diagnostico local. Explica en espanol, en 3 frases como maximo, el fallo y el siguiente paso. No propongas ejecutar comandos destructivos.",
    `version: ${report.version}`,
    `ok: ${report.ok}`,
    `fallas: ${report.errors.length ? report.errors.map((c) => c.id).join(", ") : "ninguna"}`,
    `avisos: ${report.checks.filter((c) => c.status === "warn").map((c) => `${c.id}`).join(", ") || "ninguno"}`,
    ...report.checks.filter((c) => c.status !== "ok").map((c) => `- ${c.id}: ${sanitizeMediaDetail(c.detail)}`),
  ];
  if (report.remedy) {
    parts.push(`remedio sugerido (${report.remedy.code}): ${sanitizeMediaDetail(report.remedy.remedy)}`);
    if (report.remedy.command_hint) parts.push(`comando sugerido: ${sanitizeMediaDetail(report.remedy.command_hint)}`);
  }
  const prompt = parts.join("\n");
  return prompt.length > MAX_PROMPT ? `${prompt.slice(0, MAX_PROMPT - 3)}...` : prompt;
}

/**
 * Corre el prompt con un motor inyectado. Devuelve undefined si el motor falla
 * o devuelve vacio: la explicacion es un extra, nunca un requisito.
 */
export async function explainReport(report: DoctorReport, runner: ExplainRunner): Promise<string | undefined> {
  try {
    const out = await runner(buildExplainPrompt(report));
    const text = (out ?? "").trim();
    return text.length ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Motor por defecto: `ISYMCP_EXPLAIN_CMD` recibe el prompt por stdin. */
export function defaultExplainRunner(env: NodeJS.ProcessEnv = process.env): ExplainRunner | undefined {
  const command = env[EXPLAIN_ENV]?.trim();
  if (!command) return undefined;
  return (prompt: string) =>
    new Promise<string>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        reject(error);
        return;
      }
      let stdout = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("explain timeout"));
      }, EXPLAIN_TIMEOUT_MS);
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`explain exit ${code}`));
      });
      child.stdin.end(prompt);
    });
}
