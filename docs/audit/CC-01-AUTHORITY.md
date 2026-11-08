# CC-01-AUTHORITY.md — Grafo de Autoridad y Frontera de Seguridad

**Misión:** CC-01: Control Center Security & Plugin Readiness  
**Fecha:** 2026-11-07  
**Commit Auditado:** `6e998f6` (con endurecimiento adversarial en `src/control-center/service.ts`)  
**Investigador / Auditor:** AGY / Argon (Antigravity CLI)  
**Destinatario:** GPT-6 / Danny Baanks  

---

## 1. Grafo de Autoridad (UI → HTTP API → Backend → Herramientas)

El siguiente diagrama ilustra el flujo de control y las cuatro barreras independientes de verificación:

```
[ Navegador del Usuario / Cliente HTTP / Atacante ]
                        │
                        ▼  (1. Filtro de Red y Transporte)
        [src/local-guard.ts : guardLocalRequest]
        ├── Verifica Host ∈ {127.0.0.1, localhost, [::1]} (Anti-DNS Rebinding)
        ├── Verifica Origin ∈ {loopback} (Anti-CSRF / CORS)
        ├── Verifica Content-Type: application/json en mutaciones (Anti-Simple Request CSRF)
        └── Verifica Token o Cookie HttpOnly Firmada (isymcp_session)
                        │
                        ▼  (2. Router de Control Center)
        [src/control-center/router.ts : handleControlCenterApi]
        ├── Enrutamiento determinista por método y ruta
        └── Extracción y tipado de payloads JSON
                        │
                        ▼  (3. Frontera de Seguridad y Despacho)
        [src/control-center/service.ts : dispatchControlCenterAction]
        ├── Normalización canónica de alias (ACTION_ALIAS_MAP: exec/shell/bash/cmd -> shell.exec)
        ├── Detección de acciones peligrosas (DANGEROUS_ACTIONS: shell.exec, github.dispatch, etc.)
        ├── Inspección de flags críticas (tui.spawn con accept-edits o skip_permissions)
        ├── Validación ESTRICTA de tipo boolean (options.confirmed === true)
        │     └── Si confirmed !== true: ABORTO INMEDIATO con HTTP 403 (requires_confirmation)
        └── Sanitización de salida (sanitizeOutput: redacción de ghp_..., ql_..., Bearer...)
                        │
                        ▼  (4. Despachador Universal de Herramientas)
        [src/mcp/gateway.ts : dispatchIsyMcpAction]
        ├── Aislamiento de ejecución en shell (src/shell/executor.ts)
        ├── Despliegue de consolas (src/tui-launcher.ts : spawnAgyTui)
        └── Bus SQLite WAL del monitor (src/remote-monitor.ts)
```

---

## 2. Inspección de Símbolos y Líneas de Código

### A. Barrera 1: Transporte y Red (`[src/local-guard.ts:guardLocalRequest]`)
- **Anti-DNS Rebinding:** `guardLocalRequest` verifica que el `Host` pertenezca estrictamente a `LOOPBACK_HOSTS`. Si un dominio malicioso apunta por DNS a `127.0.0.1`, el request es rechazado con `403`.
- **Anti-CSRF:** En solicitudes entre orígenes (`Origin`), se rechaza cualquier origen no loopback.
- **Content-Type Enforce:** Peticiones mutantes (`POST/PUT/PATCH`) sin `application/json` son rechazadas con `415 Unsupported Media Type`, bloqueando ataques CSRF mediante formularios HTML o `<img/script>`.

### B. Barrera 2: Despachador Backend (`[src/control-center/service.ts:dispatchControlCenterAction]`)
- **Independencia Total del Frontend:** La lógica de autorización y confirmación no reside en JavaScript del navegador ni en elementos DOM. Una llamada `curl` directa al endpoint `/api/control-center/dispatch` está sujeta a las mismas reglas:
  ```typescript
  const normAction = (action || "").trim().toLowerCase();
  const canonicalAction = ACTION_ALIAS_MAP[normAction] ?? normAction;

  const isDangerous =
    DANGEROUS_ACTIONS.has(canonicalAction) ||
    (canonicalAction === "tui.spawn" &&
      (args.mode === "accept-edits" || args.dangerously_skip_permissions === true));

  if (isDangerous && options.confirmed !== true) {
    return {
      ok: false,
      action: canonicalAction,
      requires_confirmation: true,
      warning: warningMsg,
    };
  }
  ```
- **Falsación de Confusión de Tipos:** Se exige identidad booleana estricta `options.confirmed === true`. Strings como `"true"`, enteros `1`, o `{}` son evaluados como no autorizados.

### C. Barrera 3: Redacción Criptográfica y Sanitización (`[src/control-center/service.ts:sanitizeOutput]`)
- La función de sanitización recorre recursivamente strings, arreglos y objetos devueltos por cualquier comando o herramienta.
- Expresiones regulares auditan:
  - `ghp_[A-Za-z0-9_]{36,}` → `[REDACTED_GH_TOKEN]`
  - `ql_[A-Za-z0-9_-]{20,}` → `[REDACTED_LEASE_TOKEN]`
  - Cabeceras de autenticación `x-isymcp-token` y `Bearer`
  - Campos con claves `token`, `secret`, `password`, `key` con valor > 10 caracteres.

---

## 3. Veredicto de la Frontera de Autoridad

La frontera de autoridad **no depende del frontend**. La interfaz gráfica es una mera proyección declarativa; todas las restricciones de confirmación, autenticación y sanitización se ejecutan de forma inmutable en el backend antes de invocar cualquier subproceso del sistema.
