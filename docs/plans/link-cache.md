# Plan: caché compartida por ISyMCP Link (`isymcp link cache`)

Estado: diseño (2026-11-27). Rama `feat/link-cache`.

## Problema
Las dos máquinas (Victus Linux, Xeon Windows) salen al mismo WiFi de portal
(Linux ~11.6 Mbit/s, Xeon ~4.1 Mbit/s, medidos por separado) pero están unidas
por un cable de 1 Gbit/s (`10.10.0.0/24`). Hoy cada una baja lo mismo
(modelos HF, paquetes, releases) por separado. `compute_upload/fetch` mueven
archivos en trozos de 128 KiB por RPC sellado: correcto pero lento para GB.

## Diseño
1. **Almacén direccionado por contenido** en `~/.codex-web-http/cache/blobs/sha256/<aa>/<hash>`
   + índice `index.json`: clave lógica (URL normalizada, o `hf:<repo>@<rev>/<file>`)
   → sha256, tamaño, fecha. Escritura atómica (tmp + rename), verificación de hash.
2. **Ops sellados nuevos** (autoridad `office`, no `compute`: solo leen blobs):
   `cache_has {keys|hashes}` → qué tiene el peer; `cache_ticket {hash}` → URL de
   descarga de un solo uso (token aleatorio, TTL 60 s, ligado al office_id).
3. **Canal de datos en bloque**: `GET /cache/blob/<hash>?t=<ticket>` en el mismo
   servidor `link serve`, con `Range`, streaming directo del archivo (sin base64).
   El cliente re-verifica sha256 al terminar; si no cuadra, descarta. Integridad
   por hash + ticket firmado; confidencialidad: solo LAN directa por defecto
   (`10.10.0.0/24`); por Tailscale queda cifrado por WireGuard.
4. **CLI** `isymcp link cache fetch <url|hf:...> [-o dest]`: local → peers (has) →
   descarga de internet y guarda. `cache put <file> [--key]`, `cache ls`,
   `cache gc --max-gb N`. MCP: `cache_fetch`, `cache_ls`.
5. **Integraciones después**: `HF_HUB` (wrapper que resuelve por la caché),
   pip/npm via proxy local opcional.

## Tests
- store: put/get/verify, atomicidad, hash corrupto rechazado.
- ticket: un solo uso, caduca, ligado al peer.
- E2E en loopback: dos `link serve` temporales, fetch de peer con Range/reanudación.
