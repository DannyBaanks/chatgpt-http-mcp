import { spawn } from "node:child_process";

const p = spawn("npx", ["-y", "isymcp-hub-mcp"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = ""; const pending = new Map(); let stderr = "";
p.stderr.on("data", d => stderr += d);
p.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!l.trim()) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
const call = (id, method, params) => new Promise((res, rej) => {
  pending.set(id, res);
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`timeout ${method}`)); } }, 45000);
});
const tool = (id, name, args) => call(id, "tools/call", { name, arguments: args });
const text = (r) => (r.result?.content ?? []).map(c => c.text).join("");

const R = [];
const rec = (ok, label, detail) => { R.push({ ok, label, detail: String(detail).replace(/\s+/g, " ").slice(0, 150) }); console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n      ${String(detail).replace(/\s+/g, " ").slice(0, 150)}`); };

(async () => {
  let id = 1;
  // 0. handshake
  const init = await call(id++, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  rec(init.result?.serverInfo?.name === "isymcp-hub", "0. handshake initialize", JSON.stringify(init.result?.serverInfo));
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // 1. tools/list
  const tl = await call(id++, "tools/list", {});
  const names = (tl.result?.tools ?? []).map(t => t.name);
  rec(names.length === 4 && names.includes("hub_execute"), "1. tools/list (4 tools)", names.join(", "));

  // 2. hub_discover status
  const st = await tool(id++, "hub_discover", { detail: "status" });
  const servers = st.result?.structuredContent?.servers ?? [];
  const ready = servers.filter(s => s.state === "ready").map(s => s.server);
  rec(servers.length >= 20, `2. hub_discover status (${servers.length} MCP)`, `ready: ${ready.join(", ")}`);

  // 3. hub_describe real
  const de = await tool(id++, "hub_describe", { server: "isymcp-compute", tool: "hive_status" });
  const deOk = !text(de).includes('"error"');
  rec(deOk, "3. hub_describe isymcp-compute.hive_status", text(de).slice(0, 120));

  // 4. hub_execute real
  const ex = await tool(id++, "hub_execute", { server: "isymcp-compute", tool: "hive_status", arguments: {} });
  const exTxt = text(ex);
  rec(exTxt.includes("hive_root"), "4. hub_execute hive_status (dato real)", exTxt.slice(0, 120));

  // 5. catálogo de un MCP grande (rea 258 tools; llega como JSON string en content, truncado a 50)
  const cat = await tool(id++, "hub_discover", { server: "rea" });
  const catJson = JSON.parse(text(cat));
  rec(catJson.tool_count === 258 && (catJson.tools ?? []).length === 50 && catJson.truncated === true,
      "5. hub_discover server=rea (catálogo 258, página 50 + truncated)",
      `tool_count=${catJson.tool_count} page=${(catJson.tools ?? []).length} truncated=${catJson.truncated}`);
  // 5b. filtro query + limit (rea es un MCP de Android: 'read' matchea, 'git' no existe ahí)
  const cat2 = await tool(id++, "hub_discover", { server: "rea", query: "read", limit: 10 });
  const cat2Json = JSON.parse(text(cat2));
  const ok5b = (cat2Json.tools ?? []).length === 10 && /Mostrando 10 de \d+/.test(cat2Json.note ?? "");
  rec(ok5b, "5b. hub_discover query='read' limit=10 (filtro+página)", `devueltas ${(cat2Json.tools ?? []).length} · ${cat2Json.note}`);
  // 5c. BUG DEL HUB (no del paquete): un query sin match devuelve tools que no contienen el término.
  //     Verificado idéntico con el conector Zig nativo → es del daemon, no del conector npm.
  const cat3 = await tool(id++, "hub_discover", { server: "rea", query: "zzzz-no-existe", limit: 5 });
  const cat3Json = JSON.parse(text(cat3));
  const bug = (cat3Json.tools ?? []).some(t => /zzzz/i.test(t.name)) === false && (cat3Json.tools ?? []).length > 0;
  rec(!bug, "5c. query sin match (BUG CONOCIDO del hub si falla)", bug ? `devuelve ${(cat3Json.tools??[]).length} tools ajenas al query · note: ${cat3Json.note}` : `devueltas ${(cat3Json.tools??[]).length}`);

  // 6. error bien formado (tool inexistente)
  const bad = await tool(id++, "hub_execute", { server: "isymcp", tool: "__no_existe__", arguments: {} });
  const badTxt = text(bad);
  rec(badTxt.includes("unknown_tool") || badTxt.includes("suggestions"), "6. error estructurado (tool inexistente)", badTxt.slice(0, 130));

  // 7. agentspipeline discover
  const ap = await tool(id++, "agentspipeline", { action: "discover" });
  const apTxt = text(ap);
  rec(apTxt.length > 40 && !apTxt.includes('"error"'), "7. agentspipeline discover", apTxt.slice(0, 130));

  // 8. ejecutar en un segundo servidor (isyco-gateway)
  const gw = await tool(id++, "hub_discover", { server: "isyco-gateway" });
  const gwJson = JSON.parse(text(gw));
  const gwTools = (gwJson.tools ?? []).map(t => t.name);
  rec(gwJson.tool_count > 10 && gwTools.length > 0, "8. hub_discover isyco-gateway", `${gwJson.tool_count} tools: ${gwTools.slice(0,4).join(", ")}`);

  // 9. cierre limpio
  p.stdin.end();
  const rc = await new Promise(r => p.on("exit", r));
  rec(rc === 0, "9. cierre limpio (stdin end → exit 0)", `rc=${rc}${stderr ? " stderr:" + stderr.slice(0,60) : ""}`);

  const pass = R.filter(x => x.ok).length;
  console.log(`\n=== E2E: ${pass}/${R.length} PASS ===`);
  process.exit(pass === R.length ? 0 : 1);
})().catch(e => { console.error("E2E ERROR:", e.message); process.exit(2); });
