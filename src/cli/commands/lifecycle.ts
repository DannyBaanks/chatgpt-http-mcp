// src/cli/commands/lifecycle.ts — `isymcp up|down|server|tunnel` (y `tunnel setup`).
import { installTunnelClient, storeRuntimeKey, storeTunnelId, validateRuntimeKey, validateTunnelId } from "../../../scripts/install-tunnel";
import { openInBrowser, serverUp, startServer, stopServer, tunnel } from "../services";
import { status } from "./status";
import type { CliModule } from "../module";

export async function askHidden(question: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || !process.stdout.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("tunnel setup requiere una terminal interactiva para ocultar las credenciales");
  }

  return await new Promise<string>((resolve, reject) => {
    let value = "";
    let escapeState: "none" | "start" | "csi" = "none";
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      input.off("data", onData);
      try { input.setRawMode(false); } catch { /* noop */ }
      process.stdout.write("\x1b[?2004l\n");
      input.pause();
    };
    const onData = (chunk: string | Buffer) => {
      for (const char of String(chunk)) {
        if (escapeState === "start") {
          escapeState = char === "[" || char === "O" ? "csi" : "none";
          continue;
        }
        if (escapeState === "csi") {
          if (char >= "@" && char <= "~") escapeState = "none";
          continue;
        }
        if (char === "\x1b") { escapeState = "start"; continue; }
        if (char === "\x03") {
          cleanup();
          reject(new Error("hidden_input_cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (char === "\b" || char === "\x7f") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (char >= " ") value += char;
      }
    };

    process.stdout.write(question);
    input.setEncoding("utf8");
    input.on("data", onData);
    try {
      input.setRawMode(true);
      input.resume();
      process.stdout.write("\x1b[?2004h");
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export async function tunnelSetup(): Promise<void> {
  openInBrowser("https://platform.openai.com/settings/organization/general");
  console.log("Obtén las credenciales de tu organización; lo que pegues aquí no se mostrará.");
  let tunnelId: string;
  let runtimeKey: string;
  try {
    tunnelId = validateTunnelId(await askHidden("Túnel: "));
    runtimeKey = validateRuntimeKey(await askHidden("API key: "));
  } catch (error) {
    if (error instanceof Error && error.message === "hidden_input_cancelled") {
      console.log("configuración cancelada; no se guardó nada");
      return;
    }
    throw error;
  }

  const binary = await installTunnelClient();
  storeRuntimeKey(runtimeKey);
  storeTunnelId(tunnelId);
  console.log(`credenciales guardadas de forma privada; cliente listo: ${binary}`);

  if (!(await serverUp())) {
    startServer();
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (await serverUp()) { ready = true; break; }
    }
    if (!ready) throw new Error("bridge_not_ready: credenciales guardadas; revisa isymcp status");
  }

  tunnel("connect");
}

export const upModule: CliModule = {
  names: ["up"],
  async run(sub, rest) {
    const noConnector = [sub, ...rest].includes("--no-connector");
    startServer({ connector: noConnector ? null : undefined });
    await new Promise((r) => setTimeout(r, 800));
    console.log(`health: ${(await serverUp()) ? "ok" : "aun no responde"}`);
    tunnel("connect");
  },
};

export const downModule: CliModule = {
  names: ["down"],
  async run() {
    tunnel("stop");
    stopServer();
  },
};

export const serverModule: CliModule = {
  names: ["server"],
  async run(sub, rest, ctx) {
    if (sub === "start") startServer({ connector: rest.includes("--no-connector") ? null : undefined });
    else if (sub === "stop") stopServer();
    else { ctx.help(); process.exit(2); }
  },
};

export const tunnelModule: CliModule = {
  names: ["tunnel"],
  async run(sub, _rest, ctx) {
    if (sub === "setup") await tunnelSetup();
    else if (sub) tunnel(sub);
    else { ctx.help(); process.exit(2); }
  },
};
