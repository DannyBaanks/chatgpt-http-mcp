// src/github/cli.ts — Router y manejador de subcomandos para `isymcp github ...`.
import { loadStoredTokens, resolveActiveGitHubToken, setActiveToken, removeToken, validateGitHubToken } from "./tokens";
import { callGitHubApi, dispatchWorkflow, runGhCli } from "./client";
import { runGitHubTokenWizard } from "./wizard";

function printHelp(): void {
  console.log(`
🐙 isymcp github — Extensión y CLI de GitHub para ISyMCP

USO:
  isymcp github <comando> [opciones]

COMANDOS DISPONIBLES:
  isymcp github status                        Estado de autenticación, cuenta, scopes y cuota
  isymcp github whoami                        Perfil detallado del usuario y organizaciones
  isymcp github tokens                        Muestra el submenú de gestión de tokens
  isymcp github tokens wizard                 Asistente interactivo paso a paso para crear/configurar tokens con TTL
  isymcp github tokens list                   Lista los tokens guardados, tiempo restante y expiración
  isymcp github tokens use <alias>            Activa un token específico por su alias
  isymcp github tokens remove <alias>         Elimina un token guardado del almacén seguro
  isymcp github repos [usuario]               Lista los repositorios del usuario u organización
  isymcp github prs <owner/repo> [estado]     Lista pull requests (open, closed, all)
  isymcp github issues <owner/repo> [estado]  Lista issues del repositorio
  isymcp github watch-ci [run_id_o_pr]        Despierta un hijo del monitor para notificar reactivamente el fin del CI
  isymcp github dispatch <repo> <wf> [opts]   Despacha un GitHub Actions workflow_dispatch
  isymcp github api <endpoint> [opciones]     Llama directamente a cualquier endpoint de la API REST v3
  isymcp github run <gh args...>              Ejecuta comandos nativos del CLI de GitHub (gh)

EJEMPLOS:
  isymcp github status
  isymcp github tokens wizard
  isymcp github repos DannyBaanks
  isymcp github dispatch DannyBaanks/chatgpt-http-mcp ci.yml --ref main
  isymcp github api /user/orgs
  isymcp github run pr list --state open
`);
}

export async function githubCommand(sub?: string, args: string[] = []): Promise<number> {
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    printHelp();
    return 0;
  }

  if (sub === "status") {
    const active = await resolveActiveGitHubToken();
    console.log(`\n🐙 Estado de GitHub en ISyMCP:`);
    console.log(`  • Origen del token:   ${active.source.toUpperCase()}`);
    console.log(`  • Alias:              ${active.alias}`);
    console.log(`  • ¿Expirado?:         ${active.is_expired ? "SÍ (REQUIERE RENOVACIÓN)" : "No (Activo)"}`);
    if (active.expires_at) {
      const remainingHours = Math.max(0, Math.round((active.expires_at - Date.now()) / (3600 * 1000)));
      console.log(`  • Expiración:         ${new Date(active.expires_at).toLocaleString()} (quedan ~${remainingHours} horas)`);
    } else {
      console.log(`  • Expiración:         Sin fecha límite (Permanente)`);
    }

    if (!active.token) {
      console.log(`\n  ✗ No hay token disponible. Ejecuta 'isymcp github tokens wizard' para vincular uno.`);
      return 1;
    }

    const test = await validateGitHubToken(active.token);
    if (!test.valid) {
      console.log(`\n  ✗ Error de validación contra GitHub: ${test.error}`);
      return 1;
    }

    console.log(`  • Usuario conectado:  @${test.login} ${test.name ? `(${test.name})` : ""}`);
    console.log(`  • Scopes autorizados: ${test.scopes.length > 0 ? test.scopes.join(", ") : "(sin scopes específicos)"}`);
    console.log(`  • Peticiones API rest:${test.rateLimitRemaining ?? 0} restantes`);
    console.log(`\n  ✓ Conexión con GitHub 100% operativa y lista para usar.\n`);
    return 0;
  }

  if (sub === "whoami") {
    const res = await callGitHubApi<{ login: string; id: number; name: string; public_repos: number; plan?: { name: string } }>("/user");
    if (!res.ok) {
      console.error(`✗ Error consultando usuario: ${res.error}`);
      return 1;
    }
    const u = res.data!;
    console.log(`\n🐙 Perfil de GitHub (@${u.login}):`);
    console.log(`  • ID:                 ${u.id}`);
    console.log(`  • Nombre:             ${u.name ?? "Sin nombre público"}`);
    console.log(`  • Repos públicos:     ${u.public_repos}`);
    if (u.plan) console.log(`  • Plan de cuenta:     ${u.plan.name}`);
    console.log(`  • Cuota API restante: ${res.rateLimitRemaining}\n`);
    return 0;
  }

  if (sub === "tokens") {
    const [tokenSub, ...tokenRest] = args;
    if (!tokenSub || tokenSub === "list") {
      const stored = loadStoredTokens();
      const active = await resolveActiveGitHubToken();
      console.log(`\n🔑 Tokens de GitHub Almacenados en ISyMCP (~/.codex-web-http/secrets/github-tokens.json):\n`);
      if (stored.length === 0) {
        console.log(`  (No hay tokens en el almacén local.`);
        if (active.source === "gh_cli") {
          console.log(`   Se está usando automáticamente el token de GitHub CLI (@DannyBaanks))\n`);
        } else {
          console.log(`   Ejecuta 'isymcp github tokens wizard' para agregar uno)\n`);
        }
        return 0;
      }

      console.log(`  ALIAS            USUARIO         ESTADO     EXPIRACIÓN                        SCOPES`);
      console.log(`  ───────────────  ──────────────  ─────────  ────────────────────────────────  ────────────────────────────`);
      const now = Date.now();
      for (const t of stored) {
        const isExp = t.expires_at !== null && now > t.expires_at;
        const statusStr = isExp ? "EXPIRADO" : (t.active ? "★ ACTIVO" : "Inactivo");
        let expStr = "Permanente";
        if (t.expires_at) {
          const diffHours = Math.round((t.expires_at - now) / (3600 * 1000));
          expStr = isExp ? `Expiró el ${new Date(t.expires_at).toLocaleDateString()}` : `En ${diffHours}h (${new Date(t.expires_at).toLocaleDateString()})`;
        }
        const scopesStr = t.scopes.slice(0, 3).join(",") + (t.scopes.length > 3 ? ` (+${t.scopes.length - 3})` : "");
        console.log(`  ${t.alias.padEnd(15)}  ${("@" + t.login).padEnd(14)}  ${statusStr.padEnd(9)}  ${expStr.padEnd(32)}  ${scopesStr}`);
      }
      console.log(`\n  Comandos útiles:`);
      console.log(`    isymcp github tokens wizard        -> Crear / registrar nuevo token`);
      console.log(`    isymcp github tokens use <alias>   -> Activar un token`);
      console.log(`    isymcp github tokens remove <alias>-> Eliminar un token\n`);
      return 0;
    }

    if (tokenSub === "wizard" || tokenSub === "create" || tokenSub === "mint" || tokenSub === "new") {
      await runGitHubTokenWizard();
      return 0;
    }

    if (tokenSub === "use" || tokenSub === "activate") {
      const alias = tokenRest[0];
      if (!alias) {
        console.error("✗ Falta el alias del token. Uso: isymcp github tokens use <alias>");
        return 1;
      }
      const res = setActiveToken(alias);
      if (!res.ok) {
        console.error(`✗ ${res.error}`);
        return 1;
      }
      console.log(`✓ Token '${alias}' establecido como ACTIVO para ISyMCP.`);
      return 0;
    }

    if (tokenSub === "remove" || tokenSub === "rm" || tokenSub === "delete") {
      const alias = tokenRest[0];
      if (!alias) {
        console.error("✗ Falta el alias del token. Uso: isymcp github tokens remove <alias>");
        return 1;
      }
      const res = removeToken(alias);
      if (!res.ok) {
        console.error(`✗ ${res.error}`);
        return 1;
      }
      console.log(`✓ Token '${alias}' eliminado del almacén local.`);
      return 0;
    }

    console.error(`✗ Subcomando desconocido para tokens: '${tokenSub}'. Usa 'isymcp github tokens' para ver opciones.`);
    return 1;
  }

  if (sub === "repos") {
    const owner = args[0];
    const endpoint = owner ? `/users/${owner}/repos` : "/user/repos";
    const res = await callGitHubApi<Array<{ full_name: string; private: boolean; html_url: string; stargazers_count: number; updated_at: string }>>(endpoint, {
      params: { sort: "updated", per_page: 20 },
    });
    if (!res.ok || !Array.isArray(res.data)) {
      console.error(`✗ Error listando repositorios: ${res.error}`);
      return 1;
    }
    console.log(`\n📁 Repositorios recientes (${res.data.length}):\n`);
    for (const r of res.data) {
      const vis = r.private ? "🔒 Privado" : "🌐 Público";
      console.log(`  • ${r.full_name.padEnd(45)} [${vis}] ★ ${r.stargazers_count}`);
      console.log(`    URL: ${r.html_url}`);
    }
    console.log("");
    return 0;
  }

  if (sub === "prs") {
    const repo = args[0];
    if (!repo || !repo.includes("/")) {
      console.error("✗ Especifica el repositorio en formato 'owner/repo'. Ej: isymcp github prs DannyBaanks/chatgpt-http-mcp");
      return 1;
    }
    const state = args[1] || "open";
    const res = await callGitHubApi<Array<{ number: number; title: string; user: { login: string }; html_url: string; state: string }>>(`/repos/${repo}/pulls`, {
      params: { state, per_page: 20 },
    });
    if (!res.ok || !Array.isArray(res.data)) {
      console.error(`✗ Error listando PRs: ${res.error}`);
      return 1;
    }
    console.log(`\nPull Requests en ${repo} (${state}): ${res.data.length}\n`);
    for (const pr of res.data) {
      console.log(`  #${pr.number} ${pr.title} (@${pr.user.login})`);
      console.log(`    URL: ${pr.html_url}`);
    }
    console.log("");
    return 0;
  }

  if (sub === "issues") {
    const repo = args[0];
    if (!repo || !repo.includes("/")) {
      console.error("✗ Especifica el repositorio en formato 'owner/repo'. Ej: isymcp github issues DannyBaanks/chatgpt-http-mcp");
      return 1;
    }
    const state = args[1] || "open";
    const res = await callGitHubApi<Array<{ number: number; title: string; user: { login: string }; pull_request?: unknown; html_url: string }>>(`/repos/${repo}/issues`, {
      params: { state, per_page: 20 },
    });
    if (!res.ok || !Array.isArray(res.data)) {
      console.error(`✗ Error listando issues: ${res.error}`);
      return 1;
    }
    const pureIssues = res.data.filter((i) => !i.pull_request);
    console.log(`\nIssues en ${repo} (${state}): ${pureIssues.length}\n`);
    for (const i of pureIssues) {
      console.log(`  #${i.number} ${i.title} (@${i.user.login})`);
      console.log(`    URL: ${i.html_url}`);
    }
    console.log("");
    return 0;
  }

  if (sub === "dispatch") {
    const repoFull = args[0];
    const workflowId = args[1];
    if (!repoFull || !repoFull.includes("/") || !workflowId) {
      console.error("✗ Uso: isymcp github dispatch <owner/repo> <workflow_file_o_id> [--ref <branch>] [--inputs <json>]");
      return 1;
    }
    const [owner, repo] = repoFull.split("/");
    const refIdx = args.indexOf("--ref");
    const ref = refIdx !== -1 ? args[refIdx + 1] : "main";

    let inputs: Record<string, unknown> = {};
    const inputIdx = args.indexOf("--inputs");
    if (inputIdx !== -1 && args[inputIdx + 1]) {
      try {
        inputs = JSON.parse(args[inputIdx + 1]);
      } catch (err) {
        console.error(`✗ Error parseando --inputs JSON: ${(err as Error).message}`);
        return 1;
      }
    }

    console.log(`⚡ Despachando workflow '${workflowId}' en ${owner}/${repo} (ref: ${ref})...`);
    const res = await dispatchWorkflow({ owner, repo, workflowId, ref, inputs });
    if (!res.ok) {
      console.error(`✗ Error despachando workflow: ${res.error} (HTTP ${res.status})`);
      return 1;
    }
    console.log(`✓ Workflow despachado exitosamente (HTTP 204). Consulta la pestaña Actions en GitHub.`);
    return 0;
  }

  if (sub === "api") {
    const endpoint = args[0];
    if (!endpoint) {
      console.error("✗ Falta el endpoint. Uso: isymcp github api <endpoint> [--method POST] [--body <json>]");
      return 1;
    }
    let method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" = "GET";
    const mIdx = args.indexOf("--method");
    if (mIdx !== -1 && args[mIdx + 1]) {
      method = args[mIdx + 1].toUpperCase() as any;
    }

    let body: unknown = undefined;
    const bIdx = args.indexOf("--body");
    if (bIdx !== -1 && args[bIdx + 1]) {
      try {
        body = JSON.parse(args[bIdx + 1]);
      } catch {
        body = args[bIdx + 1];
      }
    }

    const res = await callGitHubApi(endpoint, { method, body });
    if (!res.ok) {
      console.error(`✗ Error: ${res.error} (HTTP ${res.status})`);
      return 1;
    }
    console.log(JSON.stringify(res.data, null, 2));
    return 0;
  }

  if (sub === "run") {
    if (args.length === 0) {
      console.error("✗ Especifica el comando de gh a ejecutar. Ej: isymcp github run pr list");
      return 1;
    }
    const res = await runGhCli(args);
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    return res.code;
  }

  if (sub === "_watch_worker") {
    const runId = args[0];
    const port = args[1] || "8799";
    const prNumber = args[2] || "";
    if (!runId) return 1;

    let finished = false;
    let attempts = 0;
    while (!finished && attempts < 360) {
      await new Promise((r) => setTimeout(r, 8000));
      attempts++;
      try {
        const res = await callGitHubApi<{
          id: number;
          name: string;
          status: string;
          conclusion: string | null;
          html_url: string;
          head_branch: string;
          repository?: { full_name: string };
        }>(`/repos/DannyBaanks/chatgpt-http-mcp/actions/runs/${runId}`);

        if (res.ok && res.data && res.data.status === "completed") {
          finished = true;
          const conclusion = res.data.conclusion ?? "completed";
          const wfName = res.data.name ?? "CI";
          const repo = res.data.repository?.full_name ?? "DannyBaanks/chatgpt-http-mcp";
          const url = res.data.html_url ?? "";
          const branch = res.data.head_branch ?? "main";

          const alertPayload = {
            source: "github",
            event: "workflow_run",
            title: `GitHub CI [${wfName}]`,
            summary: `Run #${runId} en ${branch} concluyó con status: ${conclusion.toUpperCase()}${prNumber ? ` (PR #${prNumber})` : ""}`,
            metadata: { run_id: runId, conclusion, workflow: wfName, repo, url, branch, pr: prNumber || undefined },
          };

          try {
            const postRes = await fetch(`http://127.0.0.1:${port}/isymcp/monitor/alert`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(alertPayload),
            });
            if (postRes.ok) return 0;
          } catch {
            const { openBridgeMonitorStack } = await import("../remote-monitor");
            const { db, queue } = openBridgeMonitorStack();
            try {
              queue.submitAlertTask(alertPayload);
            } finally {
              db.close();
            }
          }
          return 0;
        }
      } catch {
        // reintentar en el siguiente ciclo
      }
    }
    return 0;
  }

  if (sub === "watch-ci" || sub === "watch-run") {
    let target = args.find((a) => !a.startsWith("--"));
    const port = args[args.indexOf("--port") + 1] || "8799";
    const detach = !args.includes("--no-detach");

    let runId = target;
    let prNumber = "";

    if (!runId || runId.startsWith("#") || Number(runId) < 1000) {
      if (runId) prNumber = runId.replace("#", "");
      const runs = await callGitHubApi<{ workflow_runs: Array<{ id: number; status: string; name: string }> }>(
        `/repos/DannyBaanks/chatgpt-http-mcp/actions/runs?per_page=5`,
      );
      if (runs.ok && runs.data?.workflow_runs?.length) {
        runId = String(runs.data.workflow_runs[0].id);
      } else {
        console.error("✗ No se encontró un workflow run reciente para monitorear.");
        return 1;
      }
    }

    if (detach) {
      const { spawn } = await import("node:child_process");
      const scriptPath = process.argv[1];
      const child = spawn(process.execPath, [scriptPath, "github", "_watch_worker", String(runId), String(port), prNumber], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      console.log(`\n🐙 [isymcp:github] Watcher iniciado en proceso hijo desacoplado (PID ${child.pid}).`);
      console.log(`  • Run ID monitoreado: #${runId}${prNumber ? ` (PR #${prNumber})` : ""}`);
      console.log(`  • Destino de alerta:  http://127.0.0.1:${port}/isymcp/monitor/alert (SQLite WAL)`);
      console.log(`  • Comportamiento:     Cuando el CI termine, despertará reactivamente a Antigravity (wait-next) sin bloquear la consola.\n`);
      return 0;
    }

    console.log(`🐙 Monitoreando run #${runId} en primer plano hasta su conclusión...`);
    return await githubCommand("_watch_worker", [String(runId), port, prNumber]);
  }

  console.error(`✗ Subcomando desconocido: 'isymcp github ${sub}'. Ejecuta 'isymcp github help' para ver la lista.`);
  return 1;
}
