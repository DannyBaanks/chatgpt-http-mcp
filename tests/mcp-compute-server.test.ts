import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerComputeMcpTools, resolveDefaultPeer } from "../src/compute/register";
import { ComputeQueue, createComputeRpcHandler } from "../src/compute/queue";
import { createLinkServer } from "../src/link/server";
import { acceptPending, requestPair, trustPeer } from "../src/link/client";
import { setPeerComputeAuthority } from "../src/link/authority";
import { activeTaint, clearTaint } from "../src/taint";

const cleanupDirs: string[] = [];
function makeTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(d);
  return d;
}

afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

describe("Servidor MCP dedicado isymcp-compute", () => {
  test("registra tools directas, auto-resuelve peer único, aplica gates/taint y ejecuta compute_run con wait_ms", async () => {
    const prevHome = process.env.CODEX_WEB_HTTP_HOME;
    const prevLinkDir = process.env.ISYMCP_LINK_DIR;
    const prevShell = process.env.ISYMCP_ALLOW_HOST_SHELL;
    const prevSpawn = process.env.ISYMCP_ALLOW_AGENT_SPAWN;

    const home = makeTmp("isymcp-mcp-comp-home-");
    const dirClient = makeTmp("isymcp-mcp-comp-cli-");
    const dirHost = makeTmp("isymcp-mcp-comp-host-");
    process.env.CODEX_WEB_HTTP_HOME = home;
    process.env.ISYMCP_LINK_DIR = dirClient;
    delete process.env.ISYMCP_ALLOW_HOST_SHELL;
    delete process.env.ISYMCP_ALLOW_AGENT_SPAWN;
    clearTaint();

    const queue = new ComputeQueue({ jobsDir: join(dirHost, "jobs") });
    const { server: linkServer } = createLinkServer({
      dir: dirHost,
      hiveRoot: null,
      computeHandler: createComputeRpcHandler(queue),
    });
    await new Promise<void>((r) => linkServer.listen(0, "127.0.0.1", r));
    const addr = `127.0.0.1:${(linkServer.address() as AddressInfo).port}`;

    const mcpServer = new McpServer({ name: "isymcp-compute-test", version: "1.0.0" });
    registerComputeMcpTools(mcpServer);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);

    try {
      const listed = await mcpClient.listTools();
      const names = new Set(listed.tools.map((t) => t.name));
      for (const expected of [
        "compute_peers",
        "compute_telemetry",
        "compute_run",
        "compute_status",
        "compute_list",
        "compute_cancel",
        "compute_fetch",
        "hive_status",
        "hive_send",
        "link_delegate",
      ]) {
        expect(names.has(expected)).toBe(true);
      }

      const pair = await requestPair(addr, { dir: dirClient, port: 47831 });
      const acc = acceptPending(pair.code, dirHost)!;
      trustPeer(pair.peer, dirClient);
      setPeerComputeAuthority(acc.office_id, true, dirHost);

      // Auto-resolución de peer único
      expect(resolveDefaultPeer(undefined, dirClient)).toBe(pair.peer.office_id);

      // compute_telemetry sin pasar `peer` funciona
      const telRes = await mcpClient.callTool({ name: "compute_telemetry", arguments: {} });
      expect(telRes.isError).not.toBe(true);
      const telJson = JSON.parse((telRes.content as Array<{ text: string }>)[0]!.text);
      expect(telJson.result.slots.gpu_max).toBe(1);

      // compute_run falla cerrado sin host_shell
      const denied = await mcpClient.callTool({
        name: "compute_run",
        arguments: { argv: [process.execPath, "-e", "console.log('blocked')"] },
      });
      expect(denied.isError).toBe(true);
      expect((denied.content as Array<{ text: string }>)[0]!.text).toContain("DENIED");

      // Habilitado -> compute_run con wait_ms devuelve resultado terminado en 1 llamada y marca taint
      process.env.ISYMCP_ALLOW_HOST_SHELL = "1";
      const runRes = await mcpClient.callTool({
        name: "compute_run",
        arguments: {
          argv: [process.execPath, "-e", "console.log('mcp-compute-ok')"],
          wait_ms: 8000,
        },
      });
      expect(runRes.isError).not.toBe(true);
      const runJson = JSON.parse((runRes.content as Array<{ text: string }>)[0]!.text);
      expect(runJson.result.status).toBe("done");
      expect(String(runJson.result.stdout_chunk)).toContain("mcp-compute-ok");
      expect(activeTaint()?.sources.some((s) => s.tool === "compute_run")).toBe(true);
    } finally {
      await mcpClient.close();
      await mcpServer.close();
      linkServer.close();
      if (prevHome === undefined) delete process.env.CODEX_WEB_HTTP_HOME;
      else process.env.CODEX_WEB_HTTP_HOME = prevHome;
      if (prevLinkDir === undefined) delete process.env.ISYMCP_LINK_DIR;
      else process.env.ISYMCP_LINK_DIR = prevLinkDir;
      if (prevShell === undefined) delete process.env.ISYMCP_ALLOW_HOST_SHELL;
      else process.env.ISYMCP_ALLOW_HOST_SHELL = prevShell;
      if (prevSpawn === undefined) delete process.env.ISYMCP_ALLOW_AGENT_SPAWN;
      else process.env.ISYMCP_ALLOW_AGENT_SPAWN = prevSpawn;
    }
  });
});
