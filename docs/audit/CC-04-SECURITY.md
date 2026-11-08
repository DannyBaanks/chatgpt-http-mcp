# CC-04 — Auditoría de Seguridad y Atestación de Host (Fase B)

**Fecha:** 2026-11-07  
**Auditor:** Antigravity (AGY) para GPT-6 & Danny Baanks  
**Estado:** `DEMONSTRATED`  
**Referencia:** `src/mcp/http-server.ts`, `src/mcp/readonly.ts`, `src/mcp/main.ts`, `tests/cc-03-authority.test.ts`

---

## 1. Atestación de Frontera de Autoridad

GPT-6 subrayó un principio fundamental de seguridad informática:
> *"La separación no puede depender únicamente de `readOnlyHint`. Esa propiedad describe la intención, pero debe aplicarse en el servidor."*

En respuesta a esta exigencia, la arquitectura de ISyMCP implementa una **defensa en profundidad en cuatro capas**:

```
[ Capa 1: Transporte de Red ]
   ├── Loopback estricto (127.0.0.1)
   ├── Bloqueo de DNS Rebinding (Host validation)
   └── Control de Origen CORS estricto (Origin filter)
         │
[ Capa 2: Despacho de Servidor MCP ]
   ├── Instanciación de `createReadOnlyMcpServer()`
   └── Eliminación de herramientas de mutación por construcción
         │
[ Capa 3: Backend Tool Registry ]
   ├── Catálogo cerrado a 4 herramientas
   └── Rechazo inmediato de herramientas desconocidas (-32602 Tool not found)
         │
[ Capa 4: Sanitización de Salida ]
   ├── Redacción automática de secretos (tokens ghp_..., ql_..., Bearer)
   └── Bloqueo de rutas de sistema sensibles
```

---

## 2. Eliminación de Herramientas de Mutación

A diferencia de los entornos que intentan filtrar llamadas dinámicamente mediante middleware, el adaptador de integración **no contiene el código de ejecución en su runtime**:

| Herramienta | En Servidor Read-Only | En Servidor Universal | Comportamiento si es invocada por ChatGPT |
|---|---|---|---|
| `shell_exec` | ❌ **Eliminada** | ✅ Habilitada (con auth) | Error JSON-RPC `-32602: Tool shell_exec not found` |
| `spawn_agy_tui` | ❌ **Eliminada** | ✅ Habilitada (con auth) | Error JSON-RPC `-32602: Tool spawn_agy_tui not found` |
| `codex_exec` | ❌ **Eliminada** | ✅ Habilitada (con token) | Error JSON-RPC `-32602: Tool codex_exec not found` |
| `codex_apply_patch`| ❌ **Eliminada** | ✅ Habilitada (con token) | Error JSON-RPC `-32602: Tool codex_apply_patch not found` |
| `github_dispatch` | ❌ **Eliminada** | ✅ Habilitada (con auth) | Error JSON-RPC `-32602: Tool github_dispatch not found` |
| `isymcp` (gateway) | ❌ **Eliminada** | ✅ Habilitada | Error JSON-RPC `-32602: Tool isymcp not found` |

---

## 3. Pruebas de Resistencia y Controles Negativos

Los controles negativos ejecutados en `tests/cc-03-authority.test.ts` y `tests/mcp-http-server.test.ts` demostraron:
1. **Rechazo de Evasión por Alias:** Intentos de invocar `exec`, `shell`, `bash` son interceptados y bloqueados.
2. **Rechazo de Mutación sin Confirmación:** En la API REST, cualquier intento de mutación devuelve `{ requires_confirmation: true }` y no toca el sistema de archivos ni los procesos del host.
3. **Cero Fuga de Credenciales:** Verificado mediante tests que inyectan cadenas `ghp_1234567890abcdefghijklmnopqrstuvwxyz` y `ql_secret_token_1234567890` comprobando que son reemplazadas por `[REDACTED_GH_TOKEN]` y `[REDACTED_LEASE_TOKEN]` respectivamente.

---

## 4. Conclusión Epistémica (Fase B)
`DEMONSTRATED`: La frontera de seguridad no es cosmética ni declarativa. El backend garantiza de manera inmutable que ninguna petición originada en ChatGPT puede ejecutar comandos en el sistema operativo de Danny ni modificar repositorios.
