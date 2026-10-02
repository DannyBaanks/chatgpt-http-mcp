# PARITY — M5 (streaming, cancelacion, timeout)

Fecha: 2026-10-02. Comando: `cd codex-web-http && bun test`
(mock upstream; sin credenciales). Resultado: **22/22, exit 0**.

## Casos fijos

| # | Caso | Que se verifica | Resultado |
|---|---|---|---|
| 1 | texto | SSE identico byte a byte, con `data: [DONE]` | PASS |
| 2 | eventos multiples/ids | sin reescritura de frames | PASS |
| 3 | reset despues de `[DONE]` | el cierre sucio se normaliza; no trunca | PASS |
| 4 | reset antes de `[DONE]` | jamas se presenta como turno completo (error o truncamiento detectable) | PASS |
| 5 | error de sesion (401) | status y body del upstream se propagan | PASS |
| 6 | timeout de headers | `504 upstream_timeout` nombrado | PASS |
| 7 | cancelacion del cliente | el stream corta, el server sigue vivo, la cancelacion llega al upstream | PASS |

Tests unitarios del wrapper (`src/responses/stream.ts`):
reset tras `[DONE]` → cierra normal; reset antes → `UpstreamStreamError`.

## Diferencias declaradas (cosmeticas o de plataforma)

- **Nombres de error propios** (`upstream_timeout`, `upstream_reset_mid_stream`)
  en lugar de los textos de la referencia. La forma (`error.type`) es estable.
- **499 para cancelacion de cliente**: codigo no estandar; en ese camino el
  cliente normalmente ya no puede leer la respuesta.
- **Reset a mitad de body sobre HTTP local**: el cliente puede ver un rechazo
  de stream o un truncamiento sin `[DONE]`. Ambos son aceptables y el caso 4 lo
  exige; lo que nunca ocurre es un final falso. La semantica fina depende del
  transporte y queda documentada, no escondida.
- **Sin reescritura de eventos**: el bridge es passthrough de frames; la
  unica transformacion es la tolerancia de cierre del punto 3.

## Pendiente (NOT_DEMONSTRATED)

- Parity contra una respuesta real de la referencia en vivo: requiere login
  M1/M4 y capturar un turno real. El harness de casos ya esta listo para
  comparar cuando exista esa captura.
