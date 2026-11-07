// src/github/wizard.ts — Asistente interactivo paso a paso ("Windows Wizard style") para configurar tokens de GitHub.
import readline from "node:readline";
import { getGhCliToken, registerToken, validateGitHubToken, loadStoredTokens } from "./tokens";

function ask(question: string, defaultValue = ""): Promise<string> {
  return new Promise((resolve) => {
    const promptText = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, (ans) => {
      rl.close();
      const val = ans.trim();
      resolve(val || defaultValue);
    });
  });
}

export async function runGitHubTokenWizard(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║                 🧙 ASISTENTE DE TOKENS DE GITHUB                     ║
║              ISyMCP GitHub Token Configuration Wizard                ║
║  Configura y administra tus credenciales con expiración por horas    ║
╚══════════════════════════════════════════════════════════════════════╝
`);

  // Paso 1: Alias del Token
  const stored = loadStoredTokens();
  const defaultAlias = stored.length === 0 ? "default" : `token-${stored.length + 1}`;
  console.log("▶ PASO 1 DE 4: Identificador del Token");
  console.log("  Asigna un nombre o alias para este token (ej. 'danny-admin', 'ci-deploy', 'temporal-1h')\n");
  const alias = await ask("  Nombre del alias", defaultAlias);

  // Paso 2: Vigencia / TTL en horas
  console.log("\n▶ PASO 2 DE 4: Tiempo de validez (Expiración en Horas)");
  console.log("  Elige cuántas horas será válido este token antes de quedar inactivo.");
  console.log("  • 1   = 1 hora (prueba rápida)");
  console.log("  • 8   = 8 horas (jornada de trabajo)");
  console.log("  • 24  = 24 horas (1 día completo)");
  console.log("  • 168 = 7 días (1 semana)");
  console.log("  • 720 = 30 días (1 mes)");
  console.log("  • 0   = Permanente (sin expiración programada)\n");
  
  const hoursInput = await ask("  Duración en horas (0 para permanente)", "24");
  const hoursNum = Number(hoursInput);
  const ttl_hours = isNaN(hoursNum) || hoursNum <= 0 ? null : hoursNum;

  // Paso 3: Origen del Token
  console.log("\n▶ PASO 3 DE 4: Clave o Token de GitHub");
  const detectedGhToken = getGhCliToken();
  let tokenSecret = "";

  if (detectedGhToken) {
    console.log("  ✓ [DETECTADO] Se encontró un token de GitHub CLI activo en tu sistema.");
    const useCli = await ask("  ¿Deseas importar automáticamente este token? (S/n)", "S");
    if (useCli.toLowerCase().startsWith("s") || useCli === "") {
      tokenSecret = detectedGhToken;
    }
  }

  if (!tokenSecret) {
    console.log("  Pega tu Personal Access Token (PAT) o Fine-Grained Token de GitHub.");
    console.log("  (Puedes crearlo en: https://github.com/settings/tokens)");
    tokenSecret = await ask("  Token secreto");
  }

  if (!tokenSecret.trim()) {
    console.error("\n  ✗ Error: No se proporcionó ningún token. Asistente cancelado.");
    return;
  }

  // Paso 4: Verificación y Guardado
  console.log("\n▶ PASO 4 DE 4: Validación y Activación");
  console.log("  Verificando credenciales contra la API oficial de GitHub...");

  const validation = await validateGitHubToken(tokenSecret);
  if (!validation.valid) {
    console.error(`\n  ✗ Validación fallida: ${validation.error}`);
    console.log("  Asegúrate de que el token esté activo y no haya sido revocado en GitHub.");
    return;
  }

  console.log(`  ✓ Conexión exitosa con GitHub.`);
  console.log(`    • Usuario autenticado: @${validation.login} ${validation.name ? `(${validation.name})` : ""}`);
  console.log(`    • Scopes autorizados:  ${validation.scopes.length > 0 ? validation.scopes.join(", ") : "(sin scopes específicos)"}`);
  console.log(`    • Cuota de API rest.:  ${validation.rateLimitRemaining ?? "N/A"} peticiones/hora`);

  const makeActiveChoice = await ask("  ¿Activar este token como el preferido de ISyMCP ahora mismo? (S/n)", "S");
  const makeActive = makeActiveChoice.toLowerCase().startsWith("s") || makeActiveChoice === "";

  const notes = await ask("  Notas opcionales (ej: 'token para tareas con chatgpt')", "");

  const reg = await registerToken({
    alias,
    token: tokenSecret,
    ttl_hours,
    makeActive,
    notes: notes || undefined,
  });

  if (!reg.ok || !reg.token) {
    console.error(`\n  ✗ Error guardando el token: ${reg.error}`);
    return;
  }

  const expStr = reg.token.expires_at
    ? new Date(reg.token.expires_at).toLocaleString() + ` (en ${reg.token.ttl_hours}h)`
    : "Permanente (sin expiración)";

  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║               ✓ ¡TOKEN CONFIGURADO EXITOSAMENTE!                     ║
╚══════════════════════════════════════════════════════════════════════╝
  • Alias:        ${reg.token.alias}
  • Usuario:      @${reg.token.login}
  • Scopes:       ${reg.token.scopes.join(", ")}
  • Vigencia:     ${expStr}
  • Estado:       ${reg.token.active ? "ACTIVO (en uso)" : "Inactivo"}
  • Archivo:      ~/.codex-web-http/secrets/github-tokens.json (0600)

  Para ver tus tokens guardados:
    isymcp github tokens list

  Para realizar llamadas de prueba:
    isymcp github whoami
    isymcp github repos
`);
}
