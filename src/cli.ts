// cli.ts — arranque del server local.
import { loadConfig } from "./config";
import { startServer } from "./server";

const config = loadConfig();
const server = startServer(config);
console.log(
  `[codex-web-http] listening on http://${config.hostname}:${server.port} -> ${config.upstreamBase}`,
);

function shutdown() {
  server.stop(true);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
