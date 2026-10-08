# Consultar el canario y entender sus avisos

Desde la carpeta del proyecto:

```bash
bun run src/isymcp.ts canary status
```

**Regla de oro:** el aviso resume lo observado; la evidencia conserva el detalle. Un canario OK demuestra esas tres comprobaciones en esa fecha, no garantiza todos los usos del bridge.

El comando de arriba solo consulta el ultimo resultado. Salida real observada el 2026-10-07 (resultado guardado de una corrida anterior, no una nueva prueba en vivo):

```text
canario OK ✓ · 2026-10-07T18:23:18.596Z · bridge=temporary
  ✓ eco-a     17.0 s · exacta
  ✓ eco-b     7.3 s · exacta
  ✓ markdown  11.8 s · lista + bloque de codigo
```

Cuando falla, el panel y el CLI muestran origen, gravedad, evento, resumen, evidencia y accion. La notificacion de escritorio muestra el origen y un resumen breve; no vuelca el stack. El detalle completo queda en el JSON indicado por `evidence_ref`.

Ejemplo real de NOTICE producido por una prueba con configuracion invalida deliberada, en un directorio temporal aislado:

```json
{
  "kind": "NOTICE",
  "severity": "action_required",
  "source": "isymcp",
  "component": "canary.bridge.startup",
  "event": "canary_failed",
  "summary": "El bridge temporal no arranco: configuracion invalida.",
  "evidence_ref": "/tmp/isymcp-notice-bQxlN8/canary/failure-2026-10-07T18-57-17-838Z-6c967da6-1cfe-43c2-92d4-bc5b9260bc4d.json",
  "action": "isymcp canary status"
}
```

| Campo o estado | Como leerlo |
|---|---|
| `source` | Aplicacion que emite el aviso: `isymcp`. |
| `component` | Punto observado del fallo, por ejemplo `canary.bridge.startup`. |
| `event` | Evento estable para agrupar avisos: `canary_failed`. |
| `severity` | `info`, `warn`, `error` o `action_required`; este ultimo requiere revisar la configuracion. |
| `summary` | Explicacion corta de la causa demostrada. |
| `evidence_ref` | Archivo con el resultado y el error original. Cada fallo nuevo tiene un archivo propio. |
| `action` | Consulta sugerida; no se ejecuta automaticamente. |
| `OK` | Las tres comprobaciones del canario pasaron en la fecha indicada. |
| `FALLO` | Al menos una comprobacion fallo o no pudo completarse. |

## Trampas

- Las pruebas automatizadas provocan fallos a proposito. Aislan el entorno y sustituyen el comando de escritorio al comprobar las notificaciones: no deben mandar avisos reales.
- Un resultado antiguo puede preceder a esta semantica. El lector adapta su aviso sin reescribir la evidencia original; su referencia apunta al archivo historico disponible.
- El formato NOTICE esta separado en `src/notice.ts` para que otros productores puedan usarlo. ISyCode e ISyVR todavia no estan conectados a este emisor.
- Un fallo de arranque no demuestra un fallo de chatgpt.com. Revisa el componente indicado.
- Estos cambios no instalan el timer ni ejecutan una prueba por el tunel.
