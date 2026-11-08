# CC-01-ADVERSARIAL.md — Pruebas Negativas y Resultados Adversariales

**Misión:** CC-01: Control Center Security & Plugin Readiness  
**Fecha:** 2026-11-07  
**Test Suite:** [`tests/cc-01-adversarial.test.ts`](file:///home/danny/Development/ISyCo%20Git/chatgpt-http-mcp/tests/cc-01-adversarial.test.ts)  
**Resultado Global:** 15 PASS / 0 FAIL (37 expect calls)  

---

## 1. Tabla de Vectores de Ataque y Resultados Observados

| ID | Vector de Ataque | Payload Inyectado | Resultado Esperado | Resultado Observado | Estado |
|---|---|---|---|---|---|
| **ADV-01** | Evasión de nombre por alias `exec` | `action: "exec", {command: "whoami"}` | HTTP 403 `requires_confirmation: true` | HTTP 403 `requires_confirmation: true`, `action: "shell.exec"` | **DEMONSTRATED** |
| **ADV-02** | Evasión por alias `shell` | `action: "shell", {command: "cat /etc/passwd"}` | HTTP 403 `requires_confirmation: true` | HTTP 403 `requires_confirmation: true`, `action: "shell.exec"` | **DEMONSTRATED** |
| **ADV-03** | Evasión por alias `bash` | `action: "bash", {command: "ls"}` | HTTP 403 `requires_confirmation: true` | HTTP 403 `requires_confirmation: true`, `action: "shell.exec"` | **DEMONSTRATED** |
| **ADV-04** | Evasión por alias `dispatch` | `action: "dispatch", {workflow_id: "x"}` | HTTP 403 `requires_confirmation: true` | HTTP 403 `requires_confirmation: true`, `action: "github.dispatch"` | **DEMONSTRATED** |
| **ADV-05** | Evasión por acción `github.exec` | `action: "github.exec", {args: ["release", "delete"]}` | HTTP 403 `requires_confirmation: true` | HTTP 403 `requires_confirmation: true`, `action: "github.exec"` | **DEMONSTRATED** |
| **ADV-06** | Type-confusion con string `"true"` | `action: "shell.exec", confirmed: "true"` | HTTP 403 `requires_confirmation: true` | HTTP 403 (rechazado por no ser boolean exacto `=== true`) | **DEMONSTRATED** |
| **ADV-07** | Type-confusion con número entero `1` | `action: "shell.exec", confirmed: 1` | HTTP 403 `requires_confirmation: true` | HTTP 403 (rechazado) | **DEMONSTRATED** |
| **ADV-08** | Type-confusion con objeto `{}` | `action: "shell.exec", confirmed: {}` | HTTP 403 `requires_confirmation: true` | HTTP 403 (rechazado) | **DEMONSTRATED** |
| **ADV-09** | DNS Rebinding (Host no loopback) | `Host: attacker.com` | HTTP 403 Forbidden | HTTP 403 `type: "invalid_host"` | **DEMONSTRATED** |
| **ADV-10** | Cross-Origin Request Forgery (CORS) | `Origin: https://malicious-web.com` | HTTP 403 Forbidden | HTTP 403 `type: "invalid_origin"` | **DEMONSTRATED** |
| **ADV-11** | Simple POST CSRF sin preflight | `Content-Type: text/plain` | HTTP 415 Unsupported Media Type | HTTP 415 `type: "invalid_content_type"` | **DEMONSTRATED** |
| **ADV-12** | Fuga de GitHub PAT en stdout | `echo "token=ghp_111122223333444455556666777788889999"` | Token original redactado | Token sustituido por `[REDACTED_GH_TOKEN]` | **DEMONSTRATED** |
| **ADV-13** | Fuga de QueueLease en output | `echo "lease=ql_abcdef1234567890abcdef1234567890"` | Token original redactado | Token sustituido por `[REDACTED_LEASE_TOKEN]` | **DEMONSTRATED** |
| **ADV-14** | TUI spawn con bypass de permisos | `tui.spawn, dangerously_skip_permissions: true` | HTTP 403 `requires_confirmation: true` | HTTP 403 (bloqueado preventivamente) | **DEMONSTRATED** |
| **ADV-15** | TUI spawn en modo escritura | `tui.spawn, mode: "accept-edits"` | HTTP 403 `requires_confirmation: true` | HTTP 403 (bloqueado preventivamente) | **DEMONSTRATED** |

---

## 2. Salida Cruda de la Ejecución

```text
bun test v1.4.2 (744846f84)

tests/cc-01-adversarial.test.ts:
✓ CC-01 Adversarial Suite — Falsación de Frontera de Autoridad > 1. Ataques de Evasión por Alias y Normalización (Bypass Attempts) > ADV-01: Intento de bypass usando alias 'exec' sin confirmación es BLOQUEADO [0.42ms]
✓ CC-01 Adversarial Suite — Falsación de Frontera de Autoridad > 1. Ataques de Evasión por Alias y Normalización (Bypass Attempts) > ADV-02: Intento de bypass usando alias 'shell' sin confirmación es BLOQUEADO [0.06ms]
✓ CC-01 Adversarial Suite — Falsación de Frontera de Autoridad > 1. Ataques de Evasión por Alias y Normalización (Bypass Attempts) > ADV-03: Intento de bypass usando alias 'bash' sin confirmación es BLOQUEADO [0.04ms]
✓ CC-01 Adversarial Suite — Falsación de Frontera de Autoridad > 1. Ataques de Evasión por Alias y Normalización (Bypass Attempts) > ADV-04: Intento de bypass usando alias 'dispatch' sin confirmación es BLOQUEADO [0.04ms]
✓ CC-01 Adversarial Suite — Falsación de Frontera de Autoridad > 1. Ataques de Evasión por Alias y Normalización (Bypass Attempts) > ADV-05: Intento de bypass usando 'github.exec' sin confirmación es BLOQUEADO [0.06ms]
✓ CC-01 Adversarial Suite — Falsación de Frontera de Autoridad > 2. Confusión de Tipos en Confirmación (Type-Confusion Attacks) > ADV-06: confirmed='true' (string truthy) es RECHAZADO como falso [0.04ms]
✓ CC-01 Adversarial Suite — Falsación de Frontera de Autoridad > 2. Confusión de Tipos en Confirmación (Type-Confusion Attacks) > ADV-07: confirmed=1 (entero truthy) es RECHAZADO como falso [0.03ms]
✓ CC-01 Adversarial Suite — Falsación de Frontera de Autoridad > 2. Confusión de Tipos en Confirmación (Type-Confusion Attacks) > ADV-08: confirmed={} (objeto truthy) es RECHAZADO como falso [0.04ms]
✓ CC-01 Adversarial Suite — Falsación de Frontera de Autoridad > 3. Falsificación de Host, Origin y CSRF (Network Boundary) > ADV-09: Solicitud con Host ajeno (DNS Rebinding) es RECHAZADA por guardLocalRequest [0.76ms]
✓ CC-01 Adversarial Suite — Falsación de Frontera de Autoridad > 3. Falsificación de Host, Origin y CSRF (Network Boundary) > ADV-10: Solicitud con Origin malicioso (CORS/CSRF) es RECHAZADA [0.05ms]
✓ CC-01 Adversarial Suite — Falsación de Frontera de Autoridad > 3. Falsificación de Host, Origin y CSRF (Network Boundary) > ADV-11: Mutación POST con Content-Type simple (text/plain CSRF) es RECHAZADA [0.08ms]
✓ CC-01 Adversarial Suite — Falsación de Frontera de Autoridad > 4. Fuga de Secretos y Sanitización (Zero Token Leakage) > ADV-12: Tokens de GitHub (ghp_...) en la salida de comandos son redactados automáticamente [8.27ms]
✓ CC-01 Adversarial Suite — Falsación de Frontera de Autoridad > 4. Fuga de Secretos y Sanitización (Zero Token Leakage) > ADV-13: Tokens de QueueLease (ql_...) en respuestas son redactados automáticamente [3.50ms]
✓ CC-01 Adversarial Suite — Falsación de Frontera de Autoridad > 5. Aislamiento de TUI y Modos Peligrosos > ADV-14: tui.spawn con dangerously_skip_permissions=true sin confirmación es BLOQUEADO [0.18ms]
✓ CC-01 Adversarial Suite — Falsación de Frontera de Autoridad > 5. Aislamiento de TUI y Modos Peligrosos > ADV-15: tui.spawn con mode='accept-edits' sin confirmación es BLOQUEADO [0.05ms]

 15 pass
 0 fail
 37 expect() calls
Ran 15 tests across 1 file. [68.00ms]
```
