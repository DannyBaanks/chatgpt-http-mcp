# isymcp-hub-mcp

**Conector MCP (stdio) para el [hub ISyMCP](../../hub/): una sola conexión que te da las tools de todos los MCP de la máquina.**

Pensado para clientes que registran MCP como "programa local" (`npx -y <paquete>`): AutoClaw, Claude Code, Codex, AGY, OpenCode, cualquiera compatible con MCP stdio. Cero dependencias (Node ≥ 18).

## Qué es y qué NO es

- **ES** un conector: copia bytes entre su stdin/stdout y el socket Unix del daemon `isymcp-hub`, exactamente como el conector Zig (`isymcp-hub connect`). Si el daemon no corre, lo arranca (desacoplado) y espera.
- **NO ES** el hub: las tools (`hub_discover`, `hub_describe`, `hub_execute`, `agentspipeline`) y los MCP detrás (rea, isyco-gateway, playwright, craft-anything, iphone, pyzig-rag, wins… los que tengas en `servers.json`) siguen siendo del daemon. Este paquete no implementa ninguna tool, no añade MCP, no cambia aislamientos ni autorizaciones: **la autoridad sigue donde ya estaba**.
- Si no hay socket ni binario: **fallo explícito** con instrucciones de instalación. Nunca levanta un hub paralelo.

## Uso

Registrar en tu cliente como MCP stdio (una vez publicado):

```
command: npx
args:    [-y, isymcp-hub-mcp]
```

O sin publicar, desde el repo:

```sh
node packages/isymcp-hub-mcp/bin/isymcp-hub-mcp.mjs   # modo MCP
```

Diagnóstico:

```sh
npx -y isymcp-hub-mcp --doctor   # socket, binario, versión del hub, MCP detrás (texto)
npx -y isymcp-hub-mcp --status   # lo mismo en JSON
```

## Flujo de uso desde un agente

1. `hub_discover` (sin args o `detail: "status"`): lista los MCP del hub y sus estados.
2. `hub_describe(server, tool)`: definición e inputSchema de una tool antes de usarla.
3. `hub_execute(server, tool, arguments)`: la ejecuta. Los permisos/aislamiento son los del hub.
4. `agentspipeline`: orquestación multi-agente en worktrees con sus invariantes de seguridad (ver `hub/src/pipeline.zig`); `integration_authorized=true` sigue siendo obligatorio.

## Entorno

| Variable | Default | Qué hace |
|---|---|---|
| `ISYMCP_HUB_SOCKET` | `$XDG_RUNTIME_DIR/isymcp/hub.sock` (o `/run/user/<uid>/…`) | socket del hub |
| `ISYMCP_HUB_BIN` | `~/.codex-web-http/bin/isymcp-hub`, `~/.local/bin/isymcp-hub`, `<repo>/hub/zig-out/bin/isymcp-hub` | binario para el autostart |
| `ISYMCP_HUB_NO_AUTOSTART` | (off) | `1` = sólo conectar, nunca levantar el daemon |
| `ISYMCP_HUB_CONNECT_WAIT_MS` | `20000` | espera del autostart |
| `CODEX_WEB_HTTP_HOME` | `~/.codex-web-http` | home del bridge (log y socket de reserva) |

## Requisitos

- El hub ISyMCP instalado en la máquina (`isymcp hub install --enable`, o `cd hub && zig build -Doptimize=ReleaseSafe` con Zig 0.16). Sin él, el conector falla con instrucciones — por diseño.

## Desarrollo

```sh
npm test          # node --test: pipe byte a byte, autostart (binario falso), fallo explícito, --status
npm pack          # empaquetar
```

Parte del monorepo [chatgpt-http-mcp](../../) (workspace `packages/*`). El conector nativo en Zig (`isymcp-hub connect`) sigue siendo el de producción para TUIs; este paquete es la vía npm/npx para clientes como AutoClaw.

MIT — ver [LICENSE](LICENSE).
