# codex-web-http — Lifecycle y Ciclo de Vida

## 1. Conversación (Session Affinity)

- **REUSE por defecto**: `~/.codex-web-http/sessions/default.json` guarda la URL `/c/` y cada turno la reutiliza.
- **Rotación**: Manual (`isymcp session default` o creando un nuevo chat desde el panel).
- **Compactación y Poda**: Conversaciones que exceden los 40 mensajes ejecutan `compactChat`, conservando el objetivo inicial de la sesión y agregando una nota de contexto antes de la ventana reciente.

---

## 2. Token de Sesión MCP

| Operación | Comando |
|---|---|
| Crear sesión | `isymcp session mint --cwd <dir> [--label x] [--write] [--ttl horas]` |
| Listar sesiones | `isymcp session list` (sólo huella digital / fingerprint) |
| Revocar sesión | `isymcp session revoke <token|fp>` |
| Expiración | Por defecto a los 7 días; `--ttl 0` para sesiones persistentes sin expiración |

Regla: El token completo sólo se muestra en stdout al emitirlo; los logs y trazas usan exclusivamente el fingerprint sanitizado.

---

## 3. Estado y Persistencia ante Reinicio

| Componente | Sobrevive al Reinicio | Mecanismo |
|---|---|---|
| **Servidor HTTP Bridge** | NO | Proceso background detached (`isymcp server start`) |
| **Panel Web** | NO | Proceso background detached (`isymcp panel start`) |
| **Cookies / Sesión ChatGPT** | SÍ | `storage-state.json` (0600) |
| **Conversación casada (URL)** | SÍ | `sessions/default.json` |
| **Historial de Chats locales** | SÍ | `~/.codex-web-http/chats/<chat_id>.json` |
| **Tokens de sesión MCP** | SÍ | `~/.codex-web-http/codex-sessions.json` |
| **Telemetría y Métricas** | NO (en memoria por proceso) | Exportable vía `/metrics` a Prometheus |
| **Lanzador de Codex** | SÍ | `~/.local/bin/codex-isymcp` y `.desktop` |
| **Canario diario** | SÍ | Systemd timer `isymcp-canary.timer` |
