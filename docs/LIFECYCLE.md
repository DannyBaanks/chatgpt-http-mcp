# codex-web-http — Lifecycle (M12, 2026-10-06)

## Conversación (session affinity)

- **REUSE por defecto**: `~/.codex-web-http/sessions/default.json` guarda la URL
  `/c/` y cada turno la reutiliza ("casarse con un link"). Verificado E2E.
- **Rotación**: manual (borrar/cambiar el `conversationUrl` o `isymcp session default`).
  Automática = OPTIONAL sin evidencia de necesidad (stale-tab = DESTROYED en el
  incidente real).
- **EPHEMERAL**: sólo si el caller no tiene sesión guardada (primer turno abre chat).
- **Limpieza**: manual en la UI de ChatGPT. Borrar no rompe evidencia local
  (traza + closures quedan), pero sí la continuidad de esa conversación.
- **PERSISTENT**: la traza (`mcp-trace.log`) y `turns/` sobreviven a la conversación.

## Token de sesión MCP

| Operación | Comando |
|---|---|
| issue | `isymcp session mint --cwd <dir> [--label x] [--write]` |
| list | `isymcp session list` (sólo fingerprint) |
| rotate | mint nuevo + `revoke` del viejo (no hay epoch en este path) |
| revoke | `isymcp session revoke <token|fp>` |
| expire | no automático hoy; revocación explícita |

Regla: el token completo sólo al mintearlo; artefactos/logs usan fingerprint
(sanitizer M8).

## Restart

| Qué | Sobrevive |
|---|---|
| server HTTP | NO (se arranca con `isymcp up`) |
| browser/pestaña | NO (se relanza por proceso; storage-state.json conserva cookies) |
| conversación (URL) | SÍ (`sessions/default.json`) |
| sesiones MCP | SÍ (`codex-sessions.json`) |
| túnel | NO siempre (reconectar con `bun run tunnel:connect`; stop real cierra tmux) |
| idempotencia (turnos) | SÍ (`turns/`) |
