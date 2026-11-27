// src/link/server.ts — Servidor HTTP sellado `munder-link@1` + extensión `compute.*` (cero Electron).
import crypto from "node:crypto";
import http from "node:http";
import { HiveManager } from "../hive/manager";
import { deliverLiveMessage, listLiveRoster } from "../hive/live";
import type { HiveTask, MessageAct } from "../hive/types";
import { peerAuthority, requireComputeAuthority, requireOfficeAuthority } from "./authority";
import {
  b64u,
  hostCapacity,
  LinkError,
  MAX_BODY,
  MAX_PENDING,
  officeIdOf,
  open,
  PAIR_RATE,
  PAIR_WINDOW_MS,
  PENDING_TTL_MS,
  publicCard,
  sas,
  seal,
  type LinkIdentity,
  type LinkPeer,
  type SealedEnvelope,
} from "./crypto";
import {
  appendReceipt,
  checkOriginRef,
  defaultLinkDir,
  loadIdentity,
  loadOrigins,
  loadPeers,
  loadPending,
  originKey,
  payloadFingerprint,
  saveOrigins,
  savePending,
} from "./store";

export type ComputeRpcHandler = (
  op: string,
  args: Record<string, unknown>,
  peer: LinkPeer,
) => Promise<unknown>;

export type HiveSpawnHandler = (
  args: Record<string, unknown>,
  peer: LinkPeer,
  hive: HiveManager,
) => Promise<unknown>;

export interface LinkServerOptions {
  dir?: string;
  hiveRoot?: string | null;
  hive?: HiveManager | null;
  version?: string;
  now?: () => number;
  computeHandler?: ComputeRpcHandler;
  hiveSpawnHandler?: HiveSpawnHandler;
}

const COMPUTE_PROTECTED_OPS = new Set([
  "job_submit",
  "job_status",
  "job_list",
  "job_cancel",
  "job_fetch",
]);

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += buf.length;
      if (size > MAX_BODY) {
        reject(new LinkError("too_big", "cuerpo demasiado grande", 413));
        req.destroy();
      } else {
        chunks.push(buf);
      }
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {});
      } catch {
        reject(new LinkError("bad_json", "JSON inválido"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function receipt(kind: string, correlationId: string) {
  return { id: crypto.randomUUID(), timestamp: new Date().toISOString(), kind, correlation_id: correlationId };
}

export function createLinkServer(opts: LinkServerOptions = {}): {
  server: http.Server;
  identity: LinkIdentity;
} {
  const dir = opts.dir ?? defaultLinkDir();
  const version = opts.version ?? "isymcp-1.1";
  const now = opts.now ?? (() => Date.now());
  const identity = loadIdentity(dir);
  const seen = new Map<string, number>();
  const pairHits = new Map<string, { start: number; count: number }>();

  const resolveHive = (): HiveManager | null => {
    if (opts.hive) return opts.hive;
    if (opts.hiveRoot === null) return null;
    if (opts.hiveRoot) return new HiveManager({ hiveRoot: opts.hiveRoot });
    return null;
  };

  const requireHive = (): HiveManager => {
    const h = resolveHive();
    if (!h) {
      throw new LinkError("no_hive", "esta instancia corre en modo compute-only (sin hive local)", 503);
    }
    h.ensureHive();
    return h;
  };

  const pairAllowed = (addr: string): boolean => {
    const t = now();
    for (const [k, w] of pairHits) if (t - w.start > PAIR_WINDOW_MS) pairHits.delete(k);
    const w = pairHits.get(addr);
    if (!w) {
      pairHits.set(addr, { start: t, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= PAIR_RATE;
  };

  const card = () => publicCard(identity, { version, capacity: hostCapacity() });

  async function dispatch(payload: { op?: string; args?: Record<string, unknown> }, peer: LinkPeer): Promise<unknown> {
    const op = String(payload?.op ?? "");
    const args = (payload?.args && typeof payload.args === "object" ? payload.args : {}) as Record<string, unknown>;

    if (op === "host_telemetry") {
      if (opts.computeHandler) return opts.computeHandler(op, args, peer);
      return { host: hostCapacity(), gpu: { available: false, provider: "none", collected_at: new Date().toISOString(), gpus: [] } };
    }

    if (COMPUTE_PROTECTED_OPS.has(op)) {
      requireComputeAuthority(peer);
      if (!opts.computeHandler) {
        throw new LinkError("compute_unavailable", "el motor de cómputo no está habilitado en este servidor", 503);
      }
      return opts.computeHandler(op, args, peer);
    }

    switch (op) {
      case "status": {
        const cap: Record<string, unknown> = { ...hostCapacity() };
        const h = resolveHive();
        if (h) {
          const reg = h.registry();
          const agents = Object.entries(reg.agents).filter(([id]) => id !== (reg.godId ?? "god"));
          cap.workers_total = agents.length;
          cap.workers_idle = agents.filter(([, a]) => a.status === "idle").length;
          cap.michael_state = reg.agents[reg.godId ?? "god"]?.status ?? "offline";
          cap.tasks_open = h.tasks().tasks.filter((t) => t.status !== "done").length;
        } else {
          cap.michael_state = "offline";
        }
        return {
          office_id: identity.office_id,
          name: identity.name,
          version,
          peer_authority: peerAuthority(peer),
          capacity: cap,
        };
      }

      case "submit": {
        const h = requireHive();
        const compose = typeof args.compose === "string" ? args.compose : "";
        if (!compose.trim()) throw new LinkError("bad_args", "falta el texto de la tarea");
        const ref = checkOriginRef(args.origin_ref);
        const key = ref ? originKey(peer.office_id, ref) : null;
        const titleArg = typeof args.title === "string" ? args.title : undefined;
        const priorityArg = Number.isInteger(args.priority) ? Number(args.priority) : undefined;
        const payloadHash = payloadFingerprint({ compose, title: titleArg, priority: priorityArg });
        const origins = loadOrigins(dir);

        if (key && origins[key]?.task_id) {
          const prevHash = origins[key]!.payload_hash;
          if (prevHash && prevHash !== payloadHash) {
            throw new LinkError("origin_conflict", "origin_ref ya existe con otro contenido", 409);
          }
          const seenTask = h.tasks().tasks.find((t) => t.id === origins[key]!.task_id);
          if (seenTask) {
            return {
              task_id: seenTask.id,
              message_id: origins[key]!.message_id,
              status: "accepted",
              duplicate: true,
              receipt: receipt("link_task_duplicate", seenTask.id),
            };
          }
        }

        const taskId = `task-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
        const title = titleArg?.trim() ? titleArg.trim().slice(0, 120) : compose.trim().slice(0, 80);
        const msg = h.send(
          {
            to: "god",
            act: "request",
            subject: title,
            body: `## ISyMCP Link — tarea delegada\n**Desde:** ${peer.name} (\`${peer.office_id}\`)\n**Origin:** ${ref || "—"}\n\n${compose}`,
          },
          `link:${peer.name}`,
        );
        const task: HiveTask = {
          id: taskId,
          title,
          description: compose,
          status: "todo",
          dependsOn: [],
          priority: priorityArg ?? 5,
          createdAt: new Date().toISOString(),
          link: { from_office: peer.office_id, from_name: peer.name, origin_ref: ref, external: true },
        };
        h.addTask(task);
        if (key) {
          origins[key] = {
            origin_ref: ref!,
            task_id: taskId,
            message_id: msg.id,
            payload_hash: payloadHash,
            to_office: peer.office_id,
            to_name: peer.name,
            created_at: new Date().toISOString(),
          };
          saveOrigins(origins, dir);
        }
        appendReceipt(dir, {
          event: "received",
          from: peer.office_id,
          from_name: peer.name,
          task_id: taskId,
          origin_ref: ref,
          duplicate: false,
        });
        return {
          task_id: taskId,
          message_id: msg.id,
          status: "accepted",
          duplicate: false,
          receipt: receipt("link_task_accepted", taskId),
        };
      }

      case "get": {
        const h = requireHive();
        const taskId = String(args.task_id ?? "");
        const task = h.tasks().tasks.find((t) => t.id === taskId && t.link?.from_office === peer.office_id);
        if (!task) throw new LinkError("no_task", "esa tarea no existe o no es tuya", 404);
        const map: Record<string, string> = { todo: "queued", doing: "working", blocked: "blocked", done: "done" };
        return {
          task_id: task.id,
          status: map[task.status] ?? "queued",
          title: task.title,
          assignee: task.assignee ?? null,
          result: task.result ?? null,
          created_at: task.createdAt,
          origin_ref: task.link?.origin_ref ?? null,
          receipt: receipt("link_task_read", task.id),
        };
      }

      case "message": {
        const h = requireHive();
        const taskId = String(args.task_id ?? "");
        const task = h.tasks().tasks.find((t) => t.id === taskId && t.link?.from_office === peer.office_id);
        if (!task) throw new LinkError("no_task", "esa tarea no existe o no es tuya", 404);
        const body = typeof args.message === "string" ? args.message.trim() : "";
        if (!body) throw new LinkError("bad_args", "falta el mensaje");
        const msg = h.send(
          { to: "god", act: "inform", subject: `Re: ${task.title}`, body: `**Tarea:** ${task.id}\n**Desde:** ${peer.name}\n\n${body}` },
          `link:${peer.name}`,
        );
        return { message_id: msg.id, task_id: task.id, receipt: receipt("link_message_sent", task.id) };
      }

      case "cancel": {
        const h = requireHive();
        const taskId = String(args.task_id ?? "");
        const task = h.tasks().tasks.find((t) => t.id === taskId && t.link?.from_office === peer.office_id);
        if (!task) throw new LinkError("no_task", "esa tarea no existe o no es tuya", 404);
        const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : "sin motivo";
        h.send(
          { to: "god", act: "request", subject: `Cancel: ${task.title}`, body: `**Tarea:** ${task.id}\n**Pide:** ${peer.name}\n**Motivo:** ${reason}` },
          `link:${peer.name}`,
        );
        return { cancellation_requested: true, task_id: task.id, receipt: receipt("link_cancel_requested", task.id) };
      }

      case "reply": {
        const h = requireHive();
        const ref = checkOriginRef(args.origin_ref);
        if (!ref) throw new LinkError("bad_args", "falta o no vale esa origin_ref");
        const rec = loadOrigins(dir)[originKey(peer.office_id, ref)];
        if (!rec) throw new LinkError("unknown_origin", "no tengo ninguna tarea delegada con esa referencia", 404);
        const text = typeof args.text === "string" && args.text.trim() ? args.text.trim().slice(0, 4000) : null;
        const resultText = typeof args.result === "string" && args.result.trim() ? args.result.trim() : null;
        const status =
          typeof args.status === "string" && ["todo", "doing", "blocked", "done"].includes(args.status)
            ? (args.status as HiveTask["status"])
            : null;
        if (!text && !resultText && !status) throw new LinkError("bad_args", "no hay nada que contestar");
        h.send(
          {
            to: "god",
            act: "inform",
            subject: `Re: ${rec.origin_ref}`,
            body: [
              `**Origin_ref:** \`${ref}\``,
              `**Tarea delegada:** ${rec.task_id}`,
              `**Desde:** ${peer.name}`,
              text ? `\n${text}` : "",
              resultText ? `\n**Resultado:** ${resultText}` : "",
              status ? `\n**Estado:** ${status}` : "",
            ].join("\n"),
          },
          `link:${peer.name}`,
        );
        appendReceipt(dir, { event: "reply_received", from: peer.office_id, from_name: peer.name, task_id: rec.task_id, origin_ref: ref });
        return { origin_ref: ref, task_id: rec.task_id, status, result: resultText, receipt: receipt("link_reply_received", rec.task_id) };
      }

      case "hive_roster": {
        requireOfficeAuthority(peer);
        const h = resolveHive();
        if (!h) {
          return {
            office_id: identity.office_id,
            name: identity.name,
            hive_enabled: false,
            agents: [],
          };
        }
        h.ensureHive();
        return {
          office_id: identity.office_id,
          name: identity.name,
          hive_enabled: true,
          agents: listLiveRoster(h, {
            officeId: identity.office_id,
            includeArchived: args.include_archived === true,
          }),
        };
      }

      case "hive_deliver": {
        requireOfficeAuthority(peer);
        const h = requireHive();
        const to = typeof args.to === "string" ? args.to.trim() : "";
        if (!to) throw new LinkError("bad_args", "falta destinatario `to`");
        const subject = typeof args.subject === "string" && args.subject.trim()
          ? args.subject.trim().slice(0, 200)
          : `Mensaje desde ${peer.name}`;
        const body = typeof args.body === "string" ? args.body : "";
        const validActs: MessageAct[] = ["request", "inform", "propose", "query", "agree", "refuse", "done"];
        const act: MessageAct =
          typeof args.act === "string" && (validActs as string[]).includes(args.act)
            ? (args.act as MessageAct)
            : "request";
        const rawFrom = typeof args.from === "string" && args.from.trim() ? args.from.trim() : "agent";
        const taggedFrom = rawFrom.includes("@") ? rawFrom : `${rawFrom}@${peer.name}`;
        if (to !== "broadcast" && to !== "god" && to !== "human") {
          const reg = h.registry();
          if (!reg.agents[to]) {
            throw new LinkError("agent_not_found", `no existe el agente «${to}» en este Hive`, 404);
          }
        }
        const msg = deliverLiveMessage(
          h,
          {
            to,
            subject,
            body,
            act,
            in_reply_to: typeof args.in_reply_to === "string" ? args.in_reply_to : null,
            conversation: typeof args.conversation === "string" ? args.conversation : undefined,
            requires_reply: args.requires_reply === true,
          },
          taggedFrom,
        );
        appendReceipt(dir, {
          event: "hive_delivered",
          from: peer.office_id,
          from_name: peer.name,
          from_agent: taggedFrom,
          to_agent: to,
          message_id: msg.id,
        });
        return {
          delivered: true,
          office_id: identity.office_id,
          name: identity.name,
          message: msg,
          receipt: receipt("hive_delivered", msg.id),
        };
      }

      case "hive_spawn_remote": {
        requireOfficeAuthority(peer);
        const h = requireHive();
        if (!opts.hiveSpawnHandler) {
          throw new LinkError("spawn_unavailable", "hive_spawn_remote no está habilitado en este servidor", 503);
        }
        return opts.hiveSpawnHandler(args, peer, h);
      }

      default:
        throw new LinkError("bad_op", `operación desconocida: ${op}`);
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://link");
      if (req.method === "GET" && url.pathname === "/link/v1/hello") {
        return sendJson(res, 200, card());
      }

      if (req.method === "POST" && url.pathname === "/link/v1/pair") {
        const addr = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
        if (!pairAllowed(addr)) {
          throw new LinkError("rate_limited", "demasiadas solicitudes de emparejamiento desde esta dirección", 429);
        }
        const b = await readJsonBody(req);
        if (typeof b.sign_pub !== "string" || typeof b.box_pub !== "string" || typeof b.nonce !== "string") {
          throw new LinkError("bad_args", "faltan llaves");
        }
        if (officeIdOf(b.sign_pub) !== b.office_id) {
          throw new LinkError("bad_identity", "office_id no corresponde a su llave");
        }
        if (b.office_id === identity.office_id) {
          throw new LinkError("self", "no puedes emparejarte contigo mismo");
        }
        const pending = loadPending(dir, now());
        const prior = pending[String(b.office_id)];
        if (prior && prior.box_pub !== b.box_pub) {
          throw new LinkError("pending_conflict", "ya hay una solicitud pendiente de esa oficina con otras llaves", 409);
        }
        if (!prior && Object.keys(pending).length >= MAX_PENDING) {
          throw new LinkError("busy", "demasiadas solicitudes pendientes", 429);
        }
        const nonce = b64u(crypto.randomBytes(16));
        const code = sas(identity.sign.x, b.sign_pub, nonce, b.nonce, identity.box.x, b.box_pub);
        pending[String(b.office_id)] = {
          office_id: String(b.office_id),
          name: String(b.name || "desconocida").slice(0, 64),
          sign_pub: b.sign_pub,
          box_pub: b.box_pub,
          addresses: [b.port ? `${addr}:${Number(b.port)}` : ""].filter(Boolean),
          code,
          expires_at: now() + PENDING_TTL_MS,
        };
        savePending(pending, dir);
        return sendJson(res, 200, { ...publicCard(identity), nonce, version });
      }

      if (req.method === "POST" && url.pathname === "/link/v1/call") {
        const env = (await readJsonBody(req)) as unknown as SealedEnvelope;
        const peers = loadPeers(dir);
        const { peer, payload } = open<{ op?: string; args?: Record<string, unknown> }>(
          identity,
          peers,
          env,
          seen,
          now(),
        );
        const result = await dispatch(payload, peer);
        return sendJson(res, 200, seal(identity, peer, { ok: true, result, re: env.nonce }, now()));
      }

      sendJson(res, 404, { ok: false, code: "not_found" });
    } catch (e) {
      const status = e instanceof LinkError ? e.status : 500;
      const code = e instanceof LinkError ? e.code : "error";
      const error = e instanceof LinkError ? e.message : "error interno";
      sendJson(res, status, { ok: false, code, error });
    }
  });

  return { server, identity };
}
