# CC-03 — Auditoría de Aislamiento de Autoridad y Controles Negativos (Fase B)

**Fecha:** 2026-11-07  
**Auditor:** Antigravity (AGY) para GPT-6 & Danny Baanks  
**Estado:** `DEMONSTRATED`  
**Referencia de Código:** `src/mcp/readonly.ts`, `src/mcp/gateway.ts`, `tests/cc-03-authority.test.ts`

---

## 1. Principio de Mínima Autoridad por Construcción

Para la integración oficial de ChatGPT como complemento privado, la superficie de ataque se reduce a **cero mutaciones** mediante dos barreras arquitectónicas complementarias:

1. **Aislamiento a Nivel de Catálogo (Eliminación por Construcción):**
   El servidor MCP dedicado `src/mcp/readonly.ts` no carga ni importa módulos de ejecución (`src/shell/executor.ts`, `src/tui-launcher.ts`, `src/github/register.ts`, `src/media/register.ts`). Las herramientas peligrosas **no existen en la tabla de símbolos del proceso**.

2. **Aislamiento a Nivel de Despacho (Fail-Closed Backend Check):**
   Cualquier llamada dirigida a nombres ajenos al catálogo de solo lectura es interceptada inmediatamente por el protocolo MCP retornando el error estándar JSON-RPC `-32602 / -32601 (Tool not found)`.

---

## 2. Catálogo Oficial de Herramientas Autorizadas

El descubrimiento de herramientas (`tools/list`) sobre el transporte MCP de `src/mcp/readonly.ts` retorna estrictamente el siguiente conjunto cerrado:

| Nombre de la Herramienta | Tipo | Anotaciones MCP | Propósito de Inspección |
|---|---|---|---|
| `isymcp_get_overview` | Read-Only | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` | Métricas de proceso (RSS, uptime), estado de demonios loopback (:8791, :8799). |
| `isymcp_get_glossary` | Read-Only | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` | Diccionario de contratos tipados, familias y parámetros de ISyMCP. |
| `isymcp_get_tasks` | Read-Only | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` | Inspección de cola en SQLite WAL con recibos criptográficos HMAC y limitador. |
| `isymcp_get_protocol` | Read-Only | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` | Especificación Markdown `isymcp://protocol/agents.md` para auto-bootstrap. |

> [!NOTE]
> Herramientas de mutación ausentes del catálogo: `shell_exec`, `spawn_agy_tui`, `codex_exec`, `codex_apply_patch`, `codex_write_stdin`, `github_dispatch`, `github_exec`, `media_import`, `comfyui_generate`, y la herramienta universal `isymcp`.

---

## 3. Controles Negativos (Falsación de Autoridad)

Se ejecutaron pruebas adversariales sobre una conexión JSON-RPC stdio real contra `src/mcp/readonly.ts`. Todos los intentos de ejecución fueron formalmente rechazados:

### Control Negativo 1: Invocación directa a `shell_exec`
- **Petición JSON-RPC:**
  ```json
  {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"shell_exec","arguments":{"command":"echo INTRUSION"}}}
  ```
- **Respuesta del Servidor:**
  ```json
  {
    "jsonrpc": "2.0",
    "id": 2,
    "result": {
      "content": [{ "type": "text", "text": "MCP error -32602: Tool shell_exec not found" }],
      "isError": true
    }
  }
  ```
- **Resultado:** **RECHAZADO**. El comando no fue ejecutado en el sistema operativo.

### Control Negativo 2: Invocación directa a `spawn_agy_tui`
- **Petición JSON-RPC:**
  ```json
  {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"spawn_agy_tui","arguments":{"prompt":"Malicious prompt"}}}
  ```
- **Respuesta del Servidor:**
  ```json
  {
    "jsonrpc": "2.0",
    "id": 3,
    "result": {
      "content": [{ "type": "text", "text": "MCP error -32602: Tool spawn_agy_tui not found" }],
      "isError": true
    }
  }
  ```
- **Resultado:** **RECHAZADO**. Ningún proceso TUI fue lanzado.

### Control Negativo 3: Invocación directa a `codex_exec`
- **Petición JSON-RPC:**
  ```json
  {"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"codex_exec","arguments":{"command":["ls","-la"]}}}
  ```
- **Respuesta del Servidor:**
  ```json
  {
    "jsonrpc": "2.0",
    "id": 4,
    "result": {
      "content": [{ "type": "text", "text": "MCP error -32602: Tool codex_exec not found" }],
      "isError": true
    }
  }
  ```
- **Resultado:** **RECHAZADO**. Cero acceso a herramientas Codex o sandboxes.

### Control Negativo 4: Invocación a la tool universal `isymcp` con subacción `shell.exec`
- **Petición JSON-RPC:**
  ```json
  {"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"isymcp","arguments":{"action":"shell.exec","arguments":{"command":"id"}}}}
  ```
- **Respuesta del Servidor:**
  ```json
  {
    "jsonrpc": "2.0",
    "id": 5,
    "result": {
      "content": [{ "type": "text", "text": "MCP error -32602: Tool isymcp not found" }],
      "isError": true
    }
  }
  ```
- **Resultado:** **RECHAZADO**. La herramienta universal `isymcp` fue desacoplada intencionalmente del servidor de solo lectura.

### Control Negativo 5: Intento de bypass en Dispatcher REST sin confirmación
- **Llamada interna:** `dispatchControlCenterAction("exec", { command: "whoami" })`
- **Respuesta del Backend:**
  ```json
  {
    "ok": false,
    "action": "shell.exec",
    "requires_confirmation": true,
    "warning": "Ejecución de shell arbitraria: se requiere confirmación explícita para ejecutar \"whoami\"."
  }
  ```
- **Resultado:** **RECHAZADO**. Fail-closed activo ante alias y solicitudes sin confirmación explícita `confirmed: true`.

---

## 4. Conclusión Epistémica (Fase B)
`DEMONSTRATED`: Se comprueba mediante pruebas de caja negra y caja blanca que la autoridad del servidor de integración está estrictamente limitada a las 4 herramientas de lectura. Ningún agente externo, modelo ni petición JSON-RPC puede invocar herramientas de mutación a través de este conector.
