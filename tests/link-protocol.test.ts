import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { HiveManager } from "../src/hive/manager";
import { createLinkServer } from "../src/link/server";
import { acceptPending, call, delegate, requestPair, trustPeer } from "../src/link/client";
import { setPeerComputeAuthority } from "../src/link/authority";
import { open, seal } from "../src/link/crypto";
import { loadIdentity } from "../src/link/store";

const cleanupDirs: string[] = [];
function makeTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(d);
  return d;
}

afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

describe("ISyMCP Link (munder-link@1) + autoridad compute fail-closed", () => {
  test("pairing SAS v2, delegación Hive y bloqueo fail-closed de compute hasta opt-in explícito", async () => {
    const dirA = makeTmp("isymcp-link-a-");
    const dirB = makeTmp("isymcp-link-b-");
    const hiveB = new HiveManager({ hiveRoot: join(dirB, "hive"), gitEnabled: false });
    hiveB.ensureAgent({ id: "god", name: "Michael-B", cwd: dirB, isGod: true });

    let computeCalls = 0;
    const { server: srvB } = createLinkServer({
      dir: dirB,
      hive: hiveB,
      computeHandler: async (op, args, peer) => {
        computeCalls++;
        return { echoed: op, from: peer.name, args };
      },
    });

    await new Promise<void>((r) => srvB.listen(0, "127.0.0.1", r));
    const portB = (srvB.address() as AddressInfo).port;
    const addrB = `127.0.0.1:${portB}`;

    try {
      // 1. Pairing SAS v2
      const pairReq = await requestPair(addrB, { dir: dirA, port: 47831 });
      expect(pairReq.code).toMatch(/^\d{6}$/);
      const acceptedOnB = acceptPending(pairReq.code, dirB);
      expect(acceptedOnB).not.toBeNull();
      trustPeer(pairReq.peer, dirA);

      // 2. Status firmado/cifrado funciona tras pairing
      const st = await call<{ peer_authority: { office: boolean; compute: boolean } }>(
        pairReq.peer.office_id,
        "status",
        {},
        { dir: dirA },
      );
      expect(st.result.peer_authority.office).toBe(true);
      expect(st.result.peer_authority.compute).toBe(false);

      // 3. Delegación Hive clásica funciona
      const del = await delegate(pairReq.peer.office_id, "Ejecutar auditoría de logs", {
        title: "Audit",
        dir: dirA,
      });
      expect(del.result.task_id).toMatch(/^task-/);
      expect(hiveB.inbox("god").length).toBe(1);

      // 4. job_submit RECHAZADO (403 compute_denied) mientras compute=false
      let deniedCode = "";
      try {
        await call(pairReq.peer.office_id, "job_submit", { command: "echo hi" }, { dir: dirA });
      } catch (e: unknown) {
        deniedCode = (e as { code?: string }).code ?? "";
      }
      expect(deniedCode).toBe("compute_denied");
      expect(computeCalls).toBe(0);

      // 5. Operador local en B habilita compute explícitamente -> ahora pasa
      const granted = setPeerComputeAuthority(acceptedOnB!.office_id, true, dirB);
      expect(granted?.authority.compute).toBe(true);

      const jobResp = await call<{ echoed: string }>(
        pairReq.peer.office_id,
        "job_submit",
        { command: "echo hi" },
        { dir: dirA },
      );
      expect(jobResp.result.echoed).toBe("job_submit");
      expect(computeCalls).toBe(1);
    } finally {
      srvB.close();
    }
  });

  test("interoperabilidad criptográfica bit-exacta con isyco-worlds/tools/munder/lib-link.cjs", () => {
    const legacyPath =
      process.env.LEGACY_MUNDER_LINK_PATH ||
      join(resolve(import.meta.dir, "..", "..", "isyco-worlds"), "tools", "munder", "lib-link.cjs");
    if (!existsSync(legacyPath)) return;

    const req = createRequire(import.meta.url);
    const legacy = req(legacyPath) as {
      loadIdentity: (dir: string, name?: string) => ReturnType<typeof loadIdentity>;
      seal: typeof seal;
      open: typeof open;
    };

    const dirLegacy = makeTmp("isymcp-interop-legacy-");
    const dirNew = makeTmp("isymcp-interop-new-");
    const idLegacy = legacy.loadIdentity(dirLegacy, "michael-legacy");
    const idNew = loadIdentity(dirNew, "isymcp-new");

    const peerNew = {
      office_id: idNew.office_id,
      name: idNew.name,
      sign_pub: idNew.sign.x,
      box_pub: idNew.box.x,
      addresses: ["127.0.0.1:47831"],
      paired_at: new Date().toISOString(),
    };
    const peerLegacy = {
      office_id: idLegacy.office_id,
      name: idLegacy.name,
      sign_pub: idLegacy.sign.x,
      box_pub: idLegacy.box.x,
      addresses: ["127.0.0.1:47831"],
      paired_at: new Date().toISOString(),
    };

    // Legacy sella -> Nuevo abre
    const envFromLegacy = legacy.seal(idLegacy, peerNew, { op: "status", args: { ping: 1 } });
    const openedByNew = open(idNew, { [peerLegacy.office_id]: peerLegacy }, envFromLegacy, new Map());
    expect(openedByNew.payload).toEqual({ op: "status", args: { ping: 1 } });

    // Nuevo sella -> Legacy abre
    const envFromNew = seal(idNew, peerLegacy, { ok: true, result: { pong: 2 } });
    const openedByLegacy = legacy.open(idLegacy, { [peerNew.office_id]: peerNew }, envFromNew, new Map());
    expect(openedByLegacy.payload).toEqual({ ok: true, result: { pong: 2 } });
  });
});
