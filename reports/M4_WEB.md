# M4-B — Transporte Web con pestaña persistente: DEMONSTRATED

Fecha: 2026-10-02. Comando: `bun run scripts/e2e-web.ts --turns 3`
(Chrome del sistema, headless). Evidencia cruda local (0600, gitignored):
`codex-web-http/probe/evidence/web-turns-2026-10-02T20-57-28-226Z.md`.

## Resultado

| métrica | valor |
|---|---|
| startup (goto + composer) | 8.2 s |
| turno 1 / 2 / 3 | 6.3 s / 7.1 s / 10.1 s |
| respuestas | `turno 1 ok` / `turno 2 ok` / `turno 3 ok` (3/3 exactas) |
| pestaña | misma `Page` reutilizada, sin cierre entre turnos |
| PSS subárbol (bun+playwright+browser) | 799 → 953 MB (13 procesos) |

## Lo que costó y quedó resuelto

1. **Cloudflare vs headless**: con el UA por default (`HeadlessChrome`) y
   `navigator.webdriver=true` la página queda en "Un momento…". El combo que
   pasa: UA del Chrome real (el `cf_clearance` está atado a ese UA),
   `ignoreDefaultArgs: ["--enable-automation"]`,
   `--disable-blink-features=AutomationControlled` y `chromiumSandbox: true`
   para el Chrome completo.
2. **storageState**: el export de Playwright devolvía 0 cookies de un perfil
   con 72 (no desencripta el keyring). Se construye desde el header Cookie:
   `scripts/import-cookies.ts` (30 cookies, incluida la session-token partida
   y `cf_clearance`), respetando las reglas `__Host-` (host-only).
3. **DOM actual sin `data-message-author-role`**: la respuesta se extrae por
   las marcas visibles de la UI ("Tú dijiste:" / "ChatGPT dijo:") contando
   marcadores antes/después para no capturar la respuesta anterior.
4. **Primer envío flaky**: submit robusto con verificación de composer vacío,
   botón de envío como fallback y hasta 3 intentos.

## chrome-headless-shell (comparación)

- Lanza solo sin sandbox (`chromiumSandbox: false`); con sandbox falla.
- Turno 1 OK (15.3 s), pero en esa corrida los turnos 2–3 **no se enviaron**
  y el check viejo marcó falso positivo. Con el check exacto queda
  **NOT_DEMONSTRATED** para 3 turnos consecutivos.
- PSS observado con SPA cargado: ~600–770 MB vs ~800–960 MB del Chrome
  completo; la ventaja de 225 vs 397 MB medida en `about:blank` se diluye
  cuando la página real está cargada. No se elige como default todavía.

## Decisión

- **Default del transporte**: Chrome del sistema en headless con el combo
  stealth (`--browser chrome`, ya es el default de `scripts/e2e-web.ts`).
- **Shell**: queda como optimización pendiente (retry con submit robusto y
  medición aislada del browser sin bun/playwright en el subárbol).

## Seguridad

- `storage-state.json` y `~/Development/cookie.txt` contienen la sesión:
  0600, fuera de git, borrables. La evidencia de los turnos está gitignored.
