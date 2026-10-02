# H1 — HTTP Gate: VERDICT **FAIL** (con evidencia)

Fecha: 2026-10-02. Entrada: headers Authorization + Cookie copiados por el
usuario a `~/Development/cookie.txt` (sesión Chrome real, válida).
Sonda: `codex-web-http/probe/http-probe.ts:1`.
Evidencia cruda local (0600, sin cookies): `codex-web-http/probe/evidence/http-probe-2026-10-02T20-07-28-422Z.md:1`.

## Resultado por etapa

| # | Etapa | Status | Content-Type | Bytes |
|---|---|---|---|---|
| 1 | `GET /api/auth/session` (solo cookies) | **403** | text/html | 8788 |
| 2 | `GET /backend-api/conversations?...` (cookie+bearer) | **403** | text/html | 10980 |
| 3 | `POST /backend-api/f/conversation` (body mínimo) | **403** | text/html | 11186 |

Los tres 403 devuelven HTML de challenge, no JSON de la API: es **Cloudflare**,
no un error de credenciales.

## Interpretación

- La sesión es válida: se copió de un Chrome con ChatGPT funcionando.
- `cf_clearance` y demás cookies viajan en la request.
- Aun así, todos los endpoints quedan bloqueados: la diferencia entre el
  Chrome que obtuvo el challenge y `Bun.fetch` es el **cliente** (fingerprint
  TLS/HTTP2 y headers del navegador), no el contenido de la sesión.
- Por lo tanto: **el replay HTTP puro con Bun queda falsado** para
  chatgpt.com. Pedir más headers (sentinel, UA exacto) no cambia el
  fingerprint del transporte; no se le pide nada más al usuario.

## Consecuencia (según el plan)

- M1 **FAIL** ⇒ se elige el camino **M4-B**: browser mínimo
  (`chrome-headless-shell` + pestaña persistente), medido en 225 MB PSS vs
  397 MB del Chrome full, sin cierre de pestaña por turno.
- La línea NB (M6) queda **más bloqueada que antes**, no menos: su 403 de
  `https://chatgpt.com/` es el mismo tipo de bloqueo.
- El **passthrough nativo (M2)** sigue siendo HTTP puro sin navegador: usa la
  auth nativa de Codex contra `chatgpt.com/backend-api/codex`, que no pasa por
  este challenge. La arquitectura final probable: nativo por HTTP + modelos
  Web por browser shell.

## No demostrado

- No se probó un cliente con fingerprint de Chrome (p. ej.
  `curl-impersonate`): queda como opción experimental, **no** como camino del
  MCP (agregaría una dependencia binaria fuera de Bun).
- No se probó el cURL exacto con todos los headers: irrelevante para el
  fingerprint TLS; se documenta como incógnita residual menor.

## Seguridad

- `~/Development/cookie.txt` contiene una sesión viva: **borrar** al cerrar
  esta fase.
- La evidencia adjunta no incluye valores de cookies ni tokens.
