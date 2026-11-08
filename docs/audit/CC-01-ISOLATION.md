# CC-01-ISOLATION.md — Aislamiento de Procesos, Sesiones y Workspaces

**Misión:** CC-01: Control Center Security & Plugin Readiness  
**Fecha:** 2026-11-07  
**Subsistemas Auditados:** `src/tui-launcher.ts`, `src/remote-monitor.ts`, `src/shell/executor.ts`  

---

## 1. Aislamiento del Lanzador de Consolas TUI (`[src/tui-launcher.ts:spawnAgyTui]`)

El launcher de consolas Antigravity desacopla la ejecución de agentes interactivos del proceso del servidor web:

### A. Desacoplamiento de Procesos
- `spawnAgyTui` no ejecuta la lógica de Antigravity dentro del hilo del servidor Bun.
- Lanza un proceso hijo independiente (`gnome-terminal`, `tmux` o terminal gráfica disponible) mediante `Bun.spawn` o `node:child_process.spawn`.
- La terminación del panel o del servidor HTTP no interrumpe la consola interactiva una vez abierta (proceso desacoplado en su propia sesión POSIX).

### B. Inyección de Protocolo y Cero Filtrado de Secretos
- La instrucción transmitida a la consola incorpora el protocolo oficial de bootstrap (`buildAgentBootstrapProtocol` en `src/agent-protocol.ts`).
- **No se inyectan tokens en los argumentos CLI:** Los parámetros CLI incluyen únicamente:
  - `prompt`: La instrucción del usuario.
  - `--task-id`: Identificador público de la tarea en cola (`task-tui-...`).
  - `--operation-id`: Identificador de operación correlacionada (`op-tui-...`).
  - Cero tokens de sesión (`turn_token`), cero claves privadas HMAC.
- El agente interactivo interactúa con el monitor exclusivamente a través de los comandos de alto nivel `isymcp monitor respond` o la herramienta universal `isymcp`.

---

## 2. Separación de Autoridades en SQLite WAL (`[src/remote-monitor.ts]`)

El monitor continuo garantiza que la recepción de una tarea no autorice automáticamente su ejecución:

```
[ Cliente / Interfaz / ChatGPT ]
               │
               ▼ (QueueLease: ql_...)
    [ tasks: state = 'PENDING' ]
               │
               ▼ (LeaseAuthority: Requiere TaskGrant independiente)
    [ tasks: state = 'READY' / 'AWAITING_APPROVAL' ]
               │
               ▼ (WorkerAdapter: Requiere workerSecret HMAC)
    [ tasks: state = 'SUCCEEDED' con receipt_hmac ]
```

### A. Las 4 Autoridades Desacopladas
1. **`OwnerGrant` (Autoridad Máxima):** Emitido con clave privada local `monitor-owner.key` (permisos 0600). Es estrictamente de un solo uso; cada consumo se registra en la tabla SQLite `used_owner_grants` para prevenir replay attacks.
2. **`QueueLease` (Token de Cliente):** Token con prefijo `ql_...` que únicamente autoriza `queue:submit` y `queue:status`. No permite ejecutar comandos (`codex_exec` -> DENY).
3. **`TaskGrant` (Póliza de Ejecución):** Define qué `kinds` y qué `actions` (`tests:run`, `report:write`) están autorizadas en un `workspace_id`.
4. **`WorkerLease` (Ejecutor Local):** Efímero, generado al reclamar una tarea en estado READY. Emite un recibo firmado con HMAC-SHA256 (`workerSecret`) para garantizar que el resultado proviene de la máquina local.

---

## 3. Aislamiento de Workspaces y CWD

- **Confinamiento de Rutas:** Todas las operaciones de workspace se validan con `resolveWithinReal` en `src/codex-sessions.ts`.
- **Rechazo de Path Traversal:** Intentos de escape con secuencias `../` o enlaces simbólicos que apunten fuera del directorio asignado son rechazados antes de crear archivos o ejecutar procesos.
- **Persistencia de Directorio:** El ejecutor `src/shell/executor.ts` mantiene un registro de `currentCwd` por sesión, evitando contaminar el entorno de trabajo de otros clientes o procesos hermanos.
