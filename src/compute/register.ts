// src/compute/register.ts — Registra las tools MCP de primer nivel de `isymcp-compute`
// (cómputo remoto async Linux ↔ Windows Xeon / WSL2 / RTX 4060 + Hive headless + Link E2E).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkGate } from "../permissions";
import { markTainted } from "../taint";
import { peerAuthority } from "../link/authority";
import { call, delegate, remoteHiveDeliver, remoteHiveRoster, remoteHiveSpawn } from "../link/client";
import { prettyFingerprint } from "../link/crypto";
import { defaultLinkDir, loadIdentity, loadPeers } from "../link/store";
import { defaultHiveRoot, HiveManager } from "../hive/manager";
import {
  deliverLiveMessage,
  listLiveRoster,
  readAgentInbox,
  registerLiveAgent,
  waitForAgentMessage,
} from "../hive/live";

function okJson(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function errJson(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }, null, 2) }],
    isError: true,
  };
}

/**
 * Resuelve el peer destino: si se omite y existe exactamente 1 peer emparejado
 * (o 1 peer con permiso `compute`), lo selecciona automáticamente para comodidad del agente.
 */
export function resolveDefaultPeer(requested?: string, dir = defaultLinkDir()): string {
  const trimmed = (requested ?? "").trim();
  if (trimmed) return trimmed;
  const peers = Object.values(loadPeers(dir));
  if (peers.length === 1) return peers[0]!.office_id;
  const computePeers = peers.filter((p) => peerAuthority(p).compute);
  if (computePeers.length === 1) return computePeers[0]!.office_id;
  if (peers.length === 0) {
    throw new Error("no hay peers emparejados todavía; ejecuta `isymcp link pair <ip:puerto> --accept`");
  }
  const names = peers.map((p) => `${p.name} (${p.office_id})`).join(", ");
  throw new Error(`hay varios peers emparejados (${names}); especifica \`peer\``);
}

export function registerComputeMcpTools(server: McpServer): void {
  server.registerTool(
    "compute_peers",
    {
      description:
        "Lista la identidad local de ISyMCP Link y los peers remotos emparejados (ej. PC Windows Xeon con RTX 4060), sus direcciones y permisos (`office`, `compute`).",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const dir = defaultLinkDir();
      const id = loadIdentity(dir);
      const peers = Object.values(loadPeers(dir)).map((p) => ({
        office_id: p.office_id,
        name: p.name,
        fingerprint: prettyFingerprint(p.office_id),
        addresses: p.addresses,
        authority: peerAuthority(p),
      }));
      return okJson({ self: { office_id: id.office_id, name: id.name, fingerprint: prettyFingerprint(id.office_id) }, peers });
    },
  );

  server.registerTool(
    "compute_telemetry",
    {
      description:
        "Consulta telemetría en vivo de un peer remoto (CPU, RAM, GPU NVIDIA/RTX 4060 VRAM/temp/util vía nvidia-smi y slots GPU/CPU libres/ocupados). Si solo hay un peer emparejado, `peer` es opcional.",
      inputSchema: {
        peer: z.string().optional().describe("Nombre o office_id del peer (opcional si solo hay uno emparejado)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const peer = resolveDefaultPeer(args.peer);
        const res = await call(peer, "host_telemetry", {});
        return okJson(res);
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "compute_run",
    {
      description:
        "Ejecuta un proceso asíncrono en una máquina remota emparejada (Windows nativo, WSL2/CUDA RTX 4060 o POSIX) sobre canal cifrado E2E. Devuelve `job_id` al instante (o espera hasta `wait_ms` para comandos cortos). Requiere permiso `host_shell` local y autoridad `compute` en el peer.",
      inputSchema: {
        peer: z.string().optional().describe("Nombre o office_id del peer (opcional si solo hay uno emparejado)"),
        command: z.string().optional().describe("Comando de shell a ejecutar (obligatorio si no se pasa `argv`)"),
        argv: z.array(z.string()).optional().describe("Ejecutable y argumentos directos sin shell (preferido en Windows/WSL)"),
        target: z.enum(["auto", "win", "wsl", "posix"]).optional().default("auto").describe("Entorno de ejecución remoto"),
        wsl_distro: z.string().optional().describe("Distro WSL2 opcional cuando target='wsl' (ej. 'Ubuntu')"),
        cwd: z.string().optional().describe("Directorio de trabajo remoto (por defecto la carpeta aislada `work/` del job)"),
        gpu: z.boolean().optional().default(false).describe("Reserva un slot GPU exclusivo (serializa jobs en la RTX 4060)"),
        priority: z.enum(["idle", "below_normal", "normal"]).optional().default("below_normal").describe("Prioridad del proceso remoto"),
        env: z.record(z.string(), z.string()).optional().describe("Variables de entorno explícitas del job (el host NO filtra sus secretos)"),
        timeout_ms: z.number().optional().describe("Timeout máximo del job en ms (default 30 min, máx 4 h)"),
        label: z.string().optional().describe("Etiqueta humana corta para identificar el job"),
        files: z
          .array(z.object({ path: z.string(), content_b64: z.string() }))
          .optional()
          .describe("Archivos pequeños de entrada a colocar en `work/` antes de arrancar"),
        wait_ms: z
          .number()
          .min(0)
          .max(60_000)
          .optional()
          .default(0)
          .describe("Si >0 (máx 60000 ms), espera a que termine y devuelve stdout/stderr en esta misma llamada; si sigue corriendo, devuelve el job en curso"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const gate = checkGate("host_shell", "compute_run", {
        peer: String(args.peer ?? "auto"),
        command: String(args.command ?? (args.argv ? args.argv.join(" ") : "")),
        target: String(args.target ?? "auto"),
      });
      if (!gate.ok) return errJson(gate.message);
      try {
        const peer = resolveDefaultPeer(args.peer);
        const sub = await call<{ job_id: string; status: string }>(peer, "job_submit", {
          command: args.command,
          argv: args.argv,
          target: args.target ?? "auto",
          wsl_distro: args.wsl_distro,
          cwd: args.cwd,
          gpu: args.gpu === true,
          priority: args.priority ?? "below_normal",
          env: args.env,
          timeout_ms: args.timeout_ms,
          label: args.label,
          files: args.files,
        });
        const waitMs = Math.max(0, Math.min(60_000, Number(args.wait_ms ?? 0) || 0));
        if (waitMs <= 0) return okJson(sub);

        const jobId = sub.result.job_id;
        const deadline = Date.now() + waitMs;
        let lastStatus: unknown = sub;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 150));
          const st = await call<{ status: string }>(peer, "job_status", { job_id: jobId });
          lastStatus = st;
          if (st.result.status !== "queued" && st.result.status !== "running") {
            markTainted("compute_run", `${peer}:${jobId}`);
            return okJson(st);
          }
        }
        markTainted("compute_run", `${peer}:${jobId}`);
        return okJson(lastStatus);
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "compute_status",
    {
      description:
        "Consulta el estado de un job remoto, su tail incremental de stdout/stderr y la lista de artefactos generados en `work/`.",
      inputSchema: {
        peer: z.string().optional().describe("Nombre o office_id del peer (opcional si solo hay uno emparejado)"),
        job_id: z.string().describe("ID del job devuelto por `compute_run`"),
        stdout_offset: z.number().optional().default(0).describe("Offset en bytes para lectura incremental de stdout"),
        stderr_offset: z.number().optional().default(0).describe("Offset en bytes para lectura incremental de stderr"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const peer = resolveDefaultPeer(args.peer);
        const res = await call(peer, "job_status", {
          job_id: args.job_id,
          stdout_offset: args.stdout_offset ?? 0,
          stderr_offset: args.stderr_offset ?? 0,
        });
        markTainted("compute_status", `${peer}:${args.job_id}`);
        return okJson(res);
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "compute_list",
    {
      description: "Lista los jobs remotos lanzados por esta máquina en un peer.",
      inputSchema: {
        peer: z.string().optional().describe("Nombre o office_id del peer (opcional si solo hay uno emparejado)"),
        limit: z.number().optional().default(30).describe("Máximo de jobs a listar"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const peer = resolveDefaultPeer(args.peer);
        const res = await call(peer, "job_list", { limit: args.limit ?? 30 });
        markTainted("compute_list", peer);
        return okJson(res);
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "compute_cancel",
    {
      description: "Cancela un job remoto y mata su árbol completo de procesos (incluyendo procesos nietos/GPU).",
      inputSchema: {
        peer: z.string().optional().describe("Nombre o office_id del peer (opcional si solo hay uno emparejado)"),
        job_id: z.string().describe("ID del job a cancelar"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const peer = resolveDefaultPeer(args.peer);
        const res = await call(peer, "job_cancel", { job_id: args.job_id });
        return okJson(res);
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "compute_fetch",
    {
      description:
        "Descarga un bloque (<=128 KB en base64 + SHA-256 verificado cuando el job terminó) de un artefacto producido por un job remoto en `work/`.",
      inputSchema: {
        peer: z.string().optional().describe("Nombre o office_id del peer (opcional si solo hay uno emparejado)"),
        job_id: z.string().describe("ID del job"),
        path: z.string().describe("Ruta relativa del artefacto dentro de `work/`"),
        offset: z.number().optional().default(0).describe("Offset en bytes para descarga por chunks"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const peer = resolveDefaultPeer(args.peer);
        const res = await call(peer, "job_fetch", {
          job_id: args.job_id,
          path: args.path,
          offset: args.offset ?? 0,
        });
        markTainted("compute_fetch", `${peer}:${args.job_id}:${args.path}`);
        return okJson(res);
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "hive_status",
    {
      description: "Consulta el estado del Hive headless local (agentes registrados, tareas abiertas y salud del router).",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const hive = new HiveManager({ hiveRoot: defaultHiveRoot() });
      const reg = hive.registry();
      const tasks = hive.tasks().tasks;
      return okJson({
        hive_root: hive.root(),
        sock_path: hive.sockPath(),
        god_id: reg.godId,
        agents_total: Object.keys(reg.agents).length,
        tasks_total: tasks.length,
        tasks_open: tasks.filter((t) => t.status !== "done").length,
        router: hive.routerHealth(),
      });
    },
  );

  server.registerTool(
    "hive_send",
    {
      description: "Envía un mensaje FIPA-lite dentro del Hive headless local (requiere permiso `agent_spawn`).",
      inputSchema: {
        to: z.string().describe("Destinatario: agentId, 'god' o 'broadcast'"),
        subject: z.string().describe("Asunto del mensaje"),
        body: z.string().optional().default("").describe("Cuerpo del mensaje"),
        from: z.string().optional().default("mcp-compute").describe("Remitente"),
        act: z.enum(["request", "inform", "propose", "query", "agree", "refuse", "done"]).optional().default("request"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const gate = checkGate("agent_spawn", "hive_send", { to: args.to, subject: args.subject });
      if (!gate.ok) return errJson(gate.message);
      const hive = new HiveManager({ hiveRoot: defaultHiveRoot() });
      const msg = hive.send({ to: args.to, subject: args.subject, body: args.body ?? "", act: args.act }, args.from);
      return okJson(msg);
    },
  );

  server.registerTool(
    "link_delegate",
    {
      description: "Delega una tarea Hive a un peer remoto emparejado sobre el canal cifrado `munder-link@1` (requiere permiso `agent_spawn`).",
      inputSchema: {
        peer: z.string().optional().describe("Nombre o office_id del peer (opcional si solo hay uno emparejado)"),
        compose: z.string().describe("Instrucción/tarea a delegar al Hive remoto"),
        title: z.string().optional().describe("Título corto opcional"),
        priority: z.number().min(1).max(10).optional().describe("Prioridad 1..10"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const gate = checkGate("agent_spawn", "link_delegate", {
        peer: String(args.peer ?? "auto"),
        title: String(args.title ?? ""),
      });
      if (!gate.ok) return errJson(gate.message);
      try {
        const peer = resolveDefaultPeer(args.peer);
        const res = await delegate(peer, args.compose, { title: args.title, priority: args.priority });
        return okJson(res);
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "hive_register",
    {
      description:
        "Registra (o refresca heartbeat de) una sesión viva de agente en el Hive local con su PID real, harness y capacidades para que otros agentes locales o remotos puedan hablarle y despertarlo.",
      inputSchema: {
        agent_id: z.string().min(1).describe("Identificador único del agente (ej. 'agy-victus', 'win-agent')"),
        name: z.string().optional().describe("Nombre legible opcional"),
        harness: z.string().optional().default("agent").describe("Harness/CLI (agy, claude, codex, opencode, etc.)"),
        role: z.string().optional().describe("Rol corto opcional"),
        pid: z.number().int().positive().optional().describe("PID real del proceso del agente (por defecto process.pid)"),
        cwd: z.string().optional().describe("Directorio de trabajo de la sesión"),
        session_id: z.string().optional().describe("ID de sesión/conversación opcional"),
        wake: z.enum(["wait", "hook", "tui"]).optional().default("wait").describe("Mecanismo de despertar del agente"),
        capabilities: z.array(z.string()).optional().describe("Lista de capacidades del agente"),
        is_god: z.boolean().optional().default(false).describe("Marcar como orquestador principal (god)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const hive = new HiveManager({ hiveRoot: defaultHiveRoot() });
        const id = loadIdentity(defaultLinkDir());
        const entry = registerLiveAgent(hive, {
          agent_id: args.agent_id,
          name: args.name,
          harness: args.harness,
          role: args.role,
          pid: args.pid ?? process.pid,
          office_id: id.office_id,
          cwd: args.cwd ?? process.cwd(),
          session_id: args.session_id,
          wake: args.wake,
          capabilities: args.capabilities,
          is_god: args.is_god,
        });
        return okJson({ ok: true, agent: entry });
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "hive_roster",
    {
      description:
        "Lista los agentes registrados en el Hive local (y opcionalmente en peers remotos vía munder-link@1) con verificación real de liveness por PID (`alive: true|false`).",
      inputSchema: {
        include_remote: z.boolean().optional().default(true).describe("Si true, consulta también el roster de todos los peers emparejados"),
        include_archived: z.boolean().optional().default(false).describe("Incluir agentes archivados"),
        peer: z.string().optional().describe("Opcional: consultar solo un peer remoto específico"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const dir = defaultLinkDir();
        const self = loadIdentity(dir);
        const hive = new HiveManager({ hiveRoot: defaultHiveRoot() });
        const localAgents = listLiveRoster(hive, {
          officeId: self.office_id,
          includeArchived: args.include_archived === true,
        });
        const remotes: Array<Record<string, unknown>> = [];
        if (args.include_remote !== false) {
          const peerList = args.peer
            ? [resolveDefaultPeer(args.peer, dir)]
            : Object.values(loadPeers(dir)).map((p) => p.office_id);
          for (const pId of peerList) {
            try {
              const r = await remoteHiveRoster(pId, {
                includeArchived: args.include_archived === true,
                dir,
                timeoutMs: 4000,
              });
              remotes.push({
                peer: r.peer.name,
                office_id: r.peer.office_id,
                address: r.address,
                latency_ms: r.latency_ms,
                ...r.result,
              });
              markTainted("hive_roster", r.peer.office_id);
            } catch (e) {
              remotes.push({ peer: pId, ok: false, error: (e as Error).message });
            }
          }
        }
        return okJson({
          self: { office_id: self.office_id, name: self.name },
          local: localAgents,
          remote: remotes,
        });
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "hive_talk",
    {
      description:
        "Envía un mensaje directo a otro agente en el Hive local (`to='agente'`) o en un peer remoto (`to='agente@peer'`) sobre canal cifrado `munder-link@1`, despertando cualquier `hive_wait` activo.",
      inputSchema: {
        to: z.string().min(1).describe("Destinatario: 'agent_id', 'god', 'broadcast', o 'agent_id@peer' para entrega remota"),
        subject: z.string().min(1).describe("Asunto corto del mensaje"),
        body: z.string().optional().default("").describe("Cuerpo del mensaje"),
        from: z.string().optional().default("agent").describe("agent_id del remitente"),
        act: z.enum(["request", "inform", "propose", "query", "agree", "refuse", "done"]).optional().default("request"),
        in_reply_to: z.string().optional().describe("ID del mensaje al que responde"),
        conversation: z.string().optional().describe("ID de conversación/hilo opcional"),
        requires_reply: z.boolean().optional().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const atIdx = args.to.indexOf("@");
        if (atIdx > 0 && atIdx < args.to.length - 1) {
          const remoteAgent = args.to.slice(0, atIdx).trim();
          const remotePeer = args.to.slice(atIdx + 1).trim();
          const res = await remoteHiveDeliver(remotePeer, {
            to: remoteAgent,
            from: args.from ?? "agent",
            subject: args.subject,
            body: args.body ?? "",
            act: args.act ?? "request",
            in_reply_to: args.in_reply_to ?? null,
            conversation: args.conversation,
            requires_reply: args.requires_reply === true,
          });
          return okJson(res);
        }
        const hive = new HiveManager({ hiveRoot: defaultHiveRoot() });
        const msg = deliverLiveMessage(
          hive,
          {
            to: args.to,
            subject: args.subject,
            body: args.body ?? "",
            act: args.act ?? "request",
            in_reply_to: args.in_reply_to ?? null,
            conversation: args.conversation,
            requires_reply: args.requires_reply === true,
          },
          args.from ?? "agent",
        );
        return okJson({ delivered: true, local: true, message: msg });
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "hive_inbox",
    {
      description: "Lee los mensajes pendientes en el inbox de un agente local del Hive.",
      inputSchema: {
        agent_id: z.string().min(1).describe("ID del agente local"),
        mark_read: z.boolean().optional().default(true).describe("Si true, mueve los mensajes leídos a inbox/.done"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const hive = new HiveManager({ hiveRoot: defaultHiveRoot() });
        const messages = readAgentInbox(hive, args.agent_id, args.mark_read !== false);
        if (messages.length > 0) markTainted("hive_inbox", args.agent_id);
        return okJson({ agent_id: args.agent_id, count: messages.length, messages });
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "hive_wait",
    {
      description:
        "Espera reactivamente hasta que llegue un mensaje nuevo al inbox de `agent_id` (sin race condition: revisa inbox antes de esperar) para despertar agentes al instante.",
      inputSchema: {
        agent_id: z.string().min(1).describe("ID del agente local que espera mensajes"),
        timeout_ms: z.number().min(0).max(300_000).optional().default(30_000).describe("Tiempo máximo de espera en ms (máx 300000)"),
        mark_read: z.boolean().optional().default(true).describe("Si true, marca los mensajes recibidos como leídos"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const hive = new HiveManager({ hiveRoot: defaultHiveRoot() });
        const res = await waitForAgentMessage(hive, args.agent_id, {
          timeoutMs: args.timeout_ms ?? 30_000,
          markRead: args.mark_read !== false,
        });
        if (res.messages.length > 0) markTainted("hive_wait", args.agent_id);
        return okJson({ agent_id: args.agent_id, ...res });
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );

  server.registerTool(
    "hive_spawn",
    {
      description:
        "Lanza un nuevo agente (local si se omite `peer`, o en un peer remoto si se especifica `peer`) pre-registrado en el Hive con `HIVE_AGENT_ID` para conversar con él (requiere permiso `agent_spawn`).",
      inputSchema: {
        peer: z.string().optional().describe("Opcional: peer remoto donde lanzar el agente; si se omite, lanza localmente"),
        harness: z.enum(["claude", "agy", "codex", "opencode"]).describe("Harness del agente a lanzar"),
        name: z.string().min(1).describe("Nombre/agent_id del nuevo agente"),
        role: z.string().optional().describe("Rol corto del agente"),
        cwd: z.string().optional().describe("Directorio de trabajo"),
        prompt: z.string().optional().default("").describe("Instrucción inicial"),
        parent_agent_id: z.string().optional().describe("agent_id del agente padre que lo lanza"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const gate = checkGate("agent_spawn", "hive_spawn", {
        peer: String(args.peer ?? "local"),
        harness: args.harness,
        name: args.name,
      });
      if (!gate.ok) return errJson(gate.message);
      try {
        if (args.peer && args.peer.trim()) {
          const peer = resolveDefaultPeer(args.peer);
          const res = await remoteHiveSpawn(peer, {
            harness: args.harness,
            name: args.name,
            role: args.role,
            cwd: args.cwd,
            prompt: args.prompt ?? "",
            parent_agent_id: args.parent_agent_id,
          });
          return okJson(res);
        }
        const hive = new HiveManager({ hiveRoot: defaultHiveRoot() });
        const spawned = hive.spawnAgent({
          agent_id: args.name,
          name: args.name,
          harness: args.harness,
          role: args.role,
          cwd: args.cwd,
          prompt: args.prompt ?? "",
          parent_agent_id: args.parent_agent_id,
        });
        return okJson({ spawned: true, local: true, agent: spawned });
      } catch (e) {
        return errJson((e as Error).message);
      }
    },
  );
}
