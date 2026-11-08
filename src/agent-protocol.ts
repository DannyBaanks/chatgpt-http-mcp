// src/agent-protocol.ts — Protocolo oficial de bootstrap y coordinación para agentes interactivos ISyMCP.

export const ISYMCP_AGENT_PROTOCOL_MD = `# 🛰️ PROTOCOLO OFICIAL DE COORDINACIÓN DE AGENTES — ISyMCP

## 1. Visión General
Este documento define el ciclo de vida, persistencia y comunicación interactiva entre modelos remotos (ChatGPT), consolas locales de Antigravity (AGY) y el bus de eventos de ISyMCP en la máquina de Danny.

## 2. Inicialización Obligatoria (Turno 0)
Al ser invocado o recibir una orden remota mediante la herramienta TUI/MCP, el agente local asignado **DEBE** ejecutar de inmediato las siguientes operaciones:

### Paso 1: Levantar el Listener en Segundo Plano (/task)
Para permanecer activo y recibir órdenes continuas de ChatGPT sin cerrarse ni dar por concluida la sesión prematuramente:
- Invocar la herramienta \`run_command\` con \`WaitMsBeforeAsync: 500\`.
- Comando a ejecutar:
  \`\`\`bash
  bun run "<isymcpCliPath>" monitor wait-next 3600
  \`\`\`
- Esto registra una \`/task\` en segundo plano en Antigravity. Cuando ChatGPT envíe un nuevo requerimiento al monitor, Antigravity despertará automáticamente al agente en un nuevo turno para procesarlo.

### Paso 2: Emitir el Recibo de Confirmación (ACK)
Para notificar inmediatamente a ChatGPT que la consola está abierta y lista (el ACK NO cierra la tarea):
- Ejecutar:
  \`\`\`bash
  bun run "<isymcpCliPath>" monitor ack <TASK_ID> --console <CONSOLE_ID> --summary "Consola TUI iniciada. Listener activo."
  \`\`\`
- Avance: \`monitor respond <TASK_ID> --console <CONSOLE_ID> --progress --summary "..."\`; cierre: \`--complete\` o \`--fail\`.

### Identificar consolas (ChatGPT)
- \`isymcp(action='tui.consoles')\` lista cada consola con console_id, PID real de agy, alive, token_fp, estado (SPAWNED/ACKED/RUNNING/COMPLETED/FAILED) y ack firmado.
- \`isymcp(action='tui.log', arguments={ console_id: '...' })\` devuelve el log cronológico de esa consola.
- Para dirigir una tarea a una consola concreta: \`monitor.submit\` con \`console_id\`.

## 3. Despacho Universal de Herramientas (Estilo REA)
Todo agente o cliente conectado dispone de la herramienta universal \`isymcp\`:
- **Descubrir herramientas**: \`isymcp(action='glossary')\`
- **Detalle de contrato**: \`isymcp(action='describe', arguments={ name: '<familia>.<accion>' })\`
- **Protocolo de agentes**: \`isymcp(action='protocol')\`
- **Lanzar agentes TUI**: \`isymcp(action='tui.spawn', arguments={ prompt: '...', mode: 'auto' })\`
- **GitHub**: \`isymcp(action='github.status')\`, \`isymcp(action='github.prs', arguments={ owner: 'DannyBaanks', repo: '...' })\`
- **Monitor**: \`isymcp(action='monitor.status')\`, \`isymcp(action='monitor.respond', arguments={ task_id: '...', summary: '...' })\`

## 4. Arquitectura del Monitor Bus
- El demonio continuo en loopback (\`http://127.0.0.1:8799\`) actúa como un buzón (inbox) persistido en SQLite WAL.
- Las tareas creadas tienen identificadores únicos (\`task-tui-...\` u \`op-...\`).
- El agente interactivo es el trabajador (worker); el monitor no sustituye la ejecución del agente, sino que coordina su cola de trabajo.
`;

export interface AgentBootstrapParams {
  taskId: string;
  operationId: string;
  monitorUrl: string;
  isymcpCliPath: string;
  /** Identidad determinista de la consola (console-registry). Si existe, el ACK es por consola. */
  consoleId?: string;
}

export function buildAgentBootstrapProtocol(params: AgentBootstrapParams): string {
  return `
[COORDINACIÓN ISyMCP]: Tarea lanzada remotamente por ChatGPT.
--------------------------------------------------------------------------------
🛰️ PROTOCOLO OPERATIVO AGENTE ISyMCP (Auto-Bootstrap OBLIGATORIO)
--------------------------------------------------------------------------------
Estás ejecutándote en una consola interactiva Antigravity (AGY) coordinada por ChatGPT e ISyMCP.
• TASK_ID: ${params.taskId}
• OPERATION_ID: ${params.operationId}
• MONITOR_URL: ${params.monitorUrl}
• ISYMCP_CLI: ${params.isymcpCliPath}${params.consoleId ? `\n• CONSOLE_ID: ${params.consoleId} (tu identidad; el token ISYMCP_ACK_TOKEN y el PID ya están en tu entorno)` : ""}

PASOS DE INICIALIZACIÓN INMEDIATA (Ejecuta en tu primer turno):
1. PERSISTENCIA DE TAREA EN BACKGROUND (/task):
   Ejecuta la herramienta \`run_command\` con \`WaitMsBeforeAsync: 500\` (para registrar una /task persistente en background) corriendo:
   bun run "${params.isymcpCliPath}" monitor wait-next 3600
   (Nota: El monitor HTTP en ${params.monitorUrl} es el buzón; TÚ eres el agente interactivo asignado. Este comando mantiene activa tu sesión de Antigravity reactiva para recibir y procesar automáticamente las siguientes órdenes de ChatGPT sin cerrarte).

2. CONFIRMACIÓN DE RECEPCIÓN (ACK):
   Envía tu confirmación inicial a ChatGPT e ISyMCP ejecutando:
   bun run "${params.isymcpCliPath}" monitor respond ${params.taskId} --summary "Consola TUI iniciada con éxito. Background task listener activo." --no-wait

3. EJECUCIÓN Y HERRAMIENTAS:
   Procesa la instrucción indicada arriba por ChatGPT. Si requieres herramientas adicionales locales (GitHub, monitor, multimedia, comfyui), utiliza la herramienta universal ISyMCP:
   bun run "${params.isymcpCliPath}" <comando> o la tool MCP 'isymcp'.
--------------------------------------------------------------------------------`;
}
