# Contexto en UN solo mensaje — DEMONSTRATED

Fecha: 2026-10-02. Herramienta: `codex-web-http/scripts/send-big.ts:1`
(mismo transporte de pestaña persistente + combo stealth de M4-B).
Verificación: token aleatorio `<<<NB-XXXXXXXX>>>` al **final** del texto;
la respuesta debe repetirlo (prueba que el tail llegó).

## Resultados crudos

| tamaño del mensaje | resultado | tiempo de respuesta |
|---|---|---|
| 54 022 bytes (`TEXTOSSSS.txt`) | PASS (nonce correcto) | 15.4 s |
| 100 009 chars | PASS | 22.9 s |
| 115 024 chars | PASS | 24.9 s |
| 150 059 chars | PASS | 30.5 s |

Evidencia local (0600, gitignored):
`codex-web-http/probe/evidence/send-big-2026-10-02T21-1*.md`.

## Lectura

1. **El fallback "un txt monstruoso" funciona**: un solo mensaje, sin partes,
   sin adjuntos, sin multipart, hasta 150 KB medidos. El modelo recibió el
   final del texto (nonce).
2. **El presupuesto de 110 KB del staging NO aplica al mensaje crudo**: era el
   tope del JSON de `codex_context_part` (wrappers + escaping + metadata), no
   del texto que la persona escribe en el composer. Por eso 115 KB pasó sin
   problema.
3. **Techos documentados** (código de la referencia):
   - composer en cuentas Instant: **211 256 chars** — el techo duro de esta
     ruta;
   - budgets de la bridge (política suya, no rechazo del server):
     Instant 41 000 ctx / 32 000 compact; Pro 104 000 / 95 000;
   - por encima del composer o del budget: adjunto `.txt` (hasta 50 MB/turno,
     10 adjuntos) o contexto-por-referencia (full harness).
4. **Límite honesto de esta prueba**: el nonce al final prueba que el *tail*
   llegó; NO prueba integridad del medio (un truncado del centro no se
   detecta así). Queda como control pendiente.

## Recomendación (modo por umbral)

| condición | camino |
|---|---|
| ≤ 150 KB y dentro del budget del modelo | **1 mensaje inline** (este modo) |
| > composer (211 KB) o > budget | **1 adjunto `.txt`** (mismo ACK) |
| full harness / re-lectura / adjuntos on-demand | contexto-por-referencia |

Con `reasoning` máximo solo cambia la selección de UI del modelo; es un paso
aparte (pendiente de automatizar en nuestro transporte).

## Pendiente

- Selección automática de effort `max` en el composer (Pro) y verificación de
  familia antes del Send.
- Control de integridad del medio (marcadores head/mid/tail).
- Fase 2 del flujo real: mención `@codex native2` y arranque del connector.
