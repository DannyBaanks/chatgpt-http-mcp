// src/hive/daemon.ts — Demonio headless del Hive (HiveManager + Router + HookServer sin Electron).
import { HiveManager, type HiveManagerOptions } from "./manager";
import { HiveHookServer, type HeadlessHookServerOptions } from "./hooks-server";

export interface HiveDaemonOptions extends HiveManagerOptions, HeadlessHookServerOptions {
  routerIntervalMs?: number;
  superviseIntervalMs?: number;
}

export interface HiveDaemonHandle {
  hive: HiveManager;
  hooks: HiveHookServer;
  sockPath: string | null;
  stop: () => void;
}

export async function startHiveDaemon(opts: HiveDaemonOptions = {}): Promise<HiveDaemonHandle> {
  const hive = new HiveManager(opts);
  hive.ensureHive();
  const hooks = new HiveHookServer(hive, opts);
  const sockPath = await hooks.start();
  hive.startRouter(opts.routerIntervalMs ?? 1500);

  const supervisor = setInterval(() => {
    hive.superviseRouter();
  }, opts.superviseIntervalMs ?? 15_000);
  supervisor.unref?.();

  return {
    hive,
    hooks,
    sockPath,
    stop() {
      clearInterval(supervisor);
      hive.stopRouter();
      hooks.stop();
    },
  };
}
