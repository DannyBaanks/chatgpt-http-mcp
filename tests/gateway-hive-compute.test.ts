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
    for (const n of ["hive.status", "hive.send", "link.peers", "link.status", "compute.telemetry", "compute.submit", "compute.status", "compute.cancel", "compute.fetch"]) {
      expect(names.has(n)).toBe(true);
    }
  });

  test("compute.submit falla cerrado sin permiso host_shell y funciona cuando el operador lo habilita", async () => {
    const prevHome = process.env.CODEX_WEB_HTTP_HOME;
    const prevShell = process.env.ISYMCP_ALLOW_HOST_SHELL;
    const home = makeTmp("isymcp-gw-home-");
    const dirClient = makeTmp("isymcp-gw-cli-");
    const dirHost = makeTmp("isymcp-gw-host-");
    process.env.CODEX_WEB_HTTP_HOME = home;
    delete process.env.ISYMCP_ALLOW_HOST_SHELL;

    const queue = new ComputeQueue({ jobsDir: join(dirHost, "jobs") });
    const { server } = createLinkServer({ dir: dirHost, hiveRoot: null, computeHandler: createComputeRpcHandler(queue) });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = `127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const pair = await requestPair(addr, { dir: dirClient, port: 47831 });
      const acc = acceptPending(pair.code, dirHost)!;
      trustPeer(pair.peer, dirClient);
      setPeerComputeAuthority(acc.office_id, true, dirHost);

      const submitAction = GATEWAY_ACTIONS.find((a) => a.name === "compute.submit")!;
      const statusAction = GATEWAY_ACTIONS.find((a) => a.name === "compute.status")!;

      // 1. Fail-closed sin permiso host_shell
      const denied = await submitAction.handler!(
        { peer: pair.peer.office_id, command: "echo blocked", link_dir: dirClient },
        "compute.submit",
      );
      expect(denied.ok).toBe(false);
      expect(String(denied.error)).toContain("DENIED");

      // 2. Habilitado explícitamente por el operador -> despacha async
      process.env.ISYMCP_ALLOW_HOST_SHELL = "1";
      const ok = await submitAction.handler!(
        { peer: pair.peer.office_id, command: "echo gw-ok", link_dir: dirClient },
        "compute.submit",
      );
      expect(ok.ok).toBe(true);
      const jobId = ((ok.result as { result: { job_id: string } }).result).job_id;
      expect(jobId).toMatch(/^job-/);

      // 3. Esperar y leer estado vía gateway
      let st: Record<string, unknown> = {};
      for (let i = 0; i < 40; i++) {
        const r = await statusAction.handler!({ peer: pair.peer.office_id, job_id: jobId, link_dir: dirClient }, "compute.status");
        st = (r.result as { result: Record<string, unknown> }).result;
        if (st.status !== "queued" && st.status !== "running") break;
        await new Promise((res) => setTimeout(res, 50));
      }
      expect(st.status).toBe("done");
      expect(String(st.stdout_chunk)).toContain("gw-ok");
    } finally {
      server.close();
      if (prevHome === undefined) delete process.env.CODEX_WEB_HTTP_HOME;
      else process.env.CODEX_WEB_HTTP_HOME = prevHome;
      if (prevShell === undefined) delete process.env.ISYMCP_ALLOW_HOST_SHELL;
      else process.env.ISYMCP_ALLOW_HOST_SHELL = prevShell;
    }
  });
});
