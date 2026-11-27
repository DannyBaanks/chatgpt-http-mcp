import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAMILY_DESCRIPTIONS, GATEWAY_ACTIONS } from "../src/mcp/gateway-actions";
import { findCliModule } from "../src/cli/module";
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

describe("CLI + Universal Gateway para hive, link y compute", () => {
  test("registra módulos CLI hive, link y compute y familias en gateway-actions", () => {
    expect(findCliModule("hive")?.names).toContain("hive");
    expect(findCliModule("link")?.names).toContain("link");
    expect(findCliModule("compute")?.names).toContain("compute");

    expect(FAMILY_DESCRIPTIONS.hive).toBeDefined();
    expect(FAMILY_DESCRIPTIONS.link).toBeDefined();
    expect(FAMILY_DESCRIPTIONS.compute).toBeDefined();

    const names = new Set(GATEWAY_ACTIONS.map((a) => a.name));
    for (const n of [
      "hive.status",
      "hive.send",
      "link.peers",
      "link.status",
      "link.submit",
      "compute.telemetry",
      "compute.submit",
      "compute.status",
      "compute.cancel",
      "compute.fetch",
    ]) {
      expect(names.has(n)).toBe(true);
    }
  });

  test("gates fail-closed en hive.send, link.submit y compute.submit + taint en resultados remotos", async () => {
    const prevHome = process.env.CODEX_WEB_HTTP_HOME;
    const prevLinkDir = process.env.ISYMCP_LINK_DIR;
    const prevShell = process.env.ISYMCP_ALLOW_HOST_SHELL;
    const prevSpawn = process.env.ISYMCP_ALLOW_AGENT_SPAWN;

    const home = makeTmp("isymcp-gw-home-");
    const dirClient = makeTmp("isymcp-gw-cli-");
    const dirHost = makeTmp("isymcp-gw-host-");
    const hiveDir = makeTmp("isymcp-gw-hive-");
    process.env.CODEX_WEB_HTTP_HOME = home;
    process.env.ISYMCP_LINK_DIR = dirClient;
    delete process.env.ISYMCP_ALLOW_HOST_SHELL;
    delete process.env.ISYMCP_ALLOW_AGENT_SPAWN;
    clearTaint();

    const queue = new ComputeQueue({ jobsDir: join(dirHost, "jobs") });
    const { server } = createLinkServer({ dir: dirHost, hiveRoot: null, computeHandler: createComputeRpcHandler(queue) });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = `127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const pair = await requestPair(addr, { dir: dirClient, port: 47831 });
      const acc = acceptPending(pair.code, dirHost)!;
      trustPeer(pair.peer, dirClient);
      setPeerComputeAuthority(acc.office_id, true, dirHost);

      const hiveSend = GATEWAY_ACTIONS.find((a) => a.name === "hive.send")!;
      const linkSubmit = GATEWAY_ACTIONS.find((a) => a.name === "link.submit")!;
      const submitAction = GATEWAY_ACTIONS.find((a) => a.name === "compute.submit")!;
      const statusAction = GATEWAY_ACTIONS.find((a) => a.name === "compute.status")!;

      // 1. Fail-closed sin permisos: hive.send, link.submit y compute.submit bloqueados
      const deniedHive = await hiveSend.handler!({ to: "god", subject: "x", hive_root: hiveDir }, "hive.send");
      expect(deniedHive.ok).toBe(false);
      expect(String(deniedHive.error)).toContain("DENIED");

      const deniedLink = await linkSubmit.handler!({ peer: pair.peer.office_id, compose: "hola" }, "link.submit");
      expect(deniedLink.ok).toBe(false);
      expect(String(deniedLink.error)).toContain("DENIED");

      const deniedCompute = await submitAction.handler!(
        { peer: pair.peer.office_id, argv: [process.execPath, "-e", "console.log('blocked')"] },
        "compute.submit",
      );
      expect(deniedCompute.ok).toBe(false);
      expect(String(deniedCompute.error)).toContain("DENIED");

      // 2. Habilitado explícitamente -> compute.submit despacha usando ISYMCP_LINK_DIR (ignora link_dir del modelo)
      process.env.ISYMCP_ALLOW_HOST_SHELL = "1";
      const ok = await submitAction.handler!(
        {
          peer: pair.peer.office_id,
          argv: [process.execPath, "-e", "console.log('gw-ok')"],
          link_dir: "/tmp/should-be-ignored-by-gateway",
        },
        "compute.submit",
      );
      expect(ok.ok).toBe(true);
      const jobId = ((ok.result as { result: { job_id: string } }).result).job_id;
      expect(jobId).toMatch(/^job-/);

      // 3. Leer estado vía gateway marca la sesión como tainted
      expect(activeTaint()).toBeNull();
      let st: Record<string, unknown> = {};
      for (let i = 0; i < 40; i++) {
        const r = await statusAction.handler!({ peer: pair.peer.office_id, job_id: jobId }, "compute.status");
        st = (r.result as { result: Record<string, unknown> }).result;
        if (st.status !== "queued" && st.status !== "running") break;
        await new Promise((res) => setTimeout(res, 50));
      }
      expect(st.status).toBe("done");
      expect(String(st.stdout_chunk)).toContain("gw-ok");

      const taint = activeTaint();
      expect(taint).not.toBeNull();
      expect(taint!.sources.some((s) => s.tool === "compute.status")).toBe(true);

      // 4. Con taint activo, ISYMCP_ALLOW_HOST_SHELL=1 ya no basta para compute.submit
      const blockedAfterTaint = await submitAction.handler!(
        { peer: pair.peer.office_id, argv: [process.execPath, "-e", "console.log('after-taint')"] },
        "compute.submit",
      );
      expect(blockedAfterTaint.ok).toBe(false);
      expect(String(blockedAfterTaint.error)).toContain("DENIED");
    } finally {
      server.close();
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
