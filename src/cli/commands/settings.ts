// src/cli/commands/settings.ts — Ajustes de ChatGPT (verificar/sincronizar) usados por el menú.
import { ask } from "../../cli/args";
import { visible } from "../../menu";
import { bridgeJson, serverUp } from "../services";

export function describeSeen(seen: unknown): string {
  const s = seen as { model?: string | null; effort?: string | null; effortPosition?: number | null; effortSteps?: number | null; at?: string } | null;
  if (!s) return "(sin lectura todavia)";
  const pos = s.effortPosition && s.effortSteps ? ` (${s.effortPosition}/${s.effortSteps})` : "";
  return `${s.model ?? "?"} · ${s.effort ?? "?"}${pos}${s.at ? ` · ${s.at}` : ""}`;
}

export async function settingsVerify(): Promise<void> {
  if (!(await serverUp())) { console.error("el server esta abajo: isymcp up"); return; }
  console.log("leyendo el selector del headless (solo lectura, ~10 s)…");
  const r = await bridgeJson("/isymcp/settings/verify", "POST");
  if (r.status !== 200) {
    console.error(`no se pudo verificar: ${JSON.stringify(r.body?.error ?? r.body)}`);
    return;
  }
  console.log(`ChatGPT ve: ${describeSeen(r.body?.seen)}`);
  const seen = r.body?.seen as { model?: string; effort?: string; effortPosition?: number; effortSteps?: number } | undefined;
  const ok = /5\.6 Sol/i.test(seen?.model ?? "") && seen?.effortPosition === 3 && seen?.effortSteps === 3;
  console.log(ok
    ? "✓ coincide con lo que anuncia el catalogo (GPT-5.6 Sol · High)"
    : "✗ no es GPT-5.6 Sol · High: Codex con el modelo web fallara cerrado (el chat del panel y `ask` si funcionan). Arreglalo con “Sincronizar a mano”.");
}

export async function settingsSync(): Promise<void> {
  if (!(await serverUp())) { console.error("el server esta abajo: isymcp up"); return; }
  const r = await bridgeJson("/isymcp/settings/open", "POST");
  if (r.status !== 202) {
    console.error(`no se abrio: ${String(r.body?.reason ?? r.status)}`);
    return;
  }
  console.log("Se abrio un Chrome visible con tu sesion. Elige GPT-5.6 Sol y reasoning High,");
  console.log("y vuelve aqui. Mientras tanto los turnos esperan en cola.");
  await ask("Enter cuando termines (guarda y cierra la ventana)… ");
  const done = await bridgeJson("/isymcp/settings/finish", "POST");
  const last = done.body?.last as { saved?: boolean; reason?: string } | null | undefined;
  console.log(last ? `${last.saved ? "✓ guardado" : "✗ no guardado"}: ${last.reason ?? ""}` :
    "ventana cerrada; el resultado aparece en unos segundos (isymcp → Ajustes → Verificar)");
}
