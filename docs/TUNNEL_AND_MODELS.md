# Túnel, API key e inyección de modelos en Codex

Fecha: 2026-10-02. Fuente de comportamiento: `codex-chatgpt-web` (MIT),
commit `28a7c79`; instalador propio: `codex-web-http/scripts/install-tunnel.ts:1`.

## Hecho hoy (verificado)

- `install-tunnel.ts` instala `openai/tunnel-client` **v0.0.12 pineado**:
  descarga `tunnel-client-v0.0.12-linux-amd64.zip` + `SHA256SUMS.txt`, verifica
  sha256, extrae con `python3 zipfile`, comprueba `--version`, escribe atómico
  y guarda manifest con hashes. Reusa si hash+versión coinciden.
- Ejecutado en este host:
  - binario `~/.codex-web-http/bin/tunnel-client` (20 MB,
    `0.0.12+881c9a8…`) + `tunnel-client-manifest.json`;
  - runtime key `~/.codex-web-http/secrets/tunnel-runtime.key`
    (164 bytes, **0600**);
  - tunnel id validado `tunnel_<32hex>` guardado en
    `~/.codex-web-http/tunnel.json`.
- Formato de las credenciales del usuario verificado sin imprimir valores:
  `tunnel_` + 32 hex (39 chars) y API key `sk-…` (164 chars, sin espacios).

## Cómo lo hace la referencia (contrato del túnel)

- `src/tunnel.ts` L11-14: versión pineada + `RELEASE_BASE` de GitHub releases.
- L25-30: solo `0.0.10` es fuente de upgrade confiable.
- L108-170: instalación con `SHA256SUMS`, manifest (archive/binary sha256),
  chequeo de `--version`, escritura atómica y rollback.
- L172-215: `installRuntimeKey` / `managedRuntimeKeyPath` →
  `secrets/tunnel-runtime-automatic.key` (o `…-zero-risk.key`), key ≤64 KB.
- L217-235: `createTunnelConfig` exige `tunnel_[a-f0-9]{32}`; alias/perfil
  `codex-chatgpt-web`.
- L260-290: `connectTunnel` ejecuta:
  `runtimes connect --alias … --profile … --profile-dir … --tunnel-client-bin
  … --tunnel-id … --runtime-api-key file:<key> --mcp-command "<cmd>" --json`
  (timeout 120 s, espera ready).
- El `--mcp-command` de la referencia es su runtime con
  `mcp --contract native --broker-socket <path>` (`mcpCommand`, MIT).

## Inyección de modelos a Codex

- Asignaciones top-level en `~/.codex/config.toml` gestionadas por la
  referencia: `openai_base_url` (`http://<host>:<port>/v1`), `model_provider`,
  `model_catalog_json` (ruta a un catálogo local). Con journal + snapshot +
  restore; se niega a sobreescribir un valor que el usuario cambió.
- `~/.codex/models_cache.json` (`getCodexModelsCachePath`, referencia
  `codex-integration-shared.ts` L254): la referencia lo refresca/invalida al
  instalar o restaurar la ruta.
- El catálogo se genera con el mismo merge que ya tenemos: template nativo +
  filas Web (`codex-web-http/src/web-models.ts:1`). En los smokes de la
  referencia: `model_catalog_json = "<root>/models.json"`.
- Nuestro `/v1/models` ya sirve ese catálogo aumentado.

## Gap para conectar (`runtimes connect`)

`runtimes connect` necesita que `--mcp-command` sea un **servidor MCP stdio**
que exponga las tools locales (`--contract native --broker-socket`). Hoy
tenemos transporte browser + passthrough, pero **no ese servidor**. Es el
bloqueante para conectar el túnel.

## Próximo (orden)

1. `src/mcp/` mínimo: stdio MCP con `--contract native --broker-socket`.
2. `scripts/connect-tunnel.ts` con el comando de conexión.
3. Generar catálogo + escribir `config.toml` (`openai_base_url`,
   `model_provider`, `model_catalog_json`) con backup/restore (patrón de
   `codex-web-http/scripts/install-codex.ts:1`) y refrescar `models_cache.json`.
4. Fase 2 real: `@codex native2` + tools.

## Seguridad

- Secrets solo bajo `~/.codex-web-http/` (0600), fuera de git; `tunnel.json`
  no contiene la key. El instalador nunca imprime valores.
