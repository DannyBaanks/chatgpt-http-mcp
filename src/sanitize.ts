// sanitize.ts — M8 (P0): evidencia reproducible != fuga de secretos.
// Redacta tokens/cookies/bearers antes de escribir dumps o artefactos.
const PATTERNS: Array<[RegExp, string]> = [
  [/turn_token:\s*\S+/gi, "turn_token: <redacted>"],
  [/request_id:\s*\S+/gi, "request_id: <redacted>"],
  [/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/g, "Bearer <redacted>"],
  [/sk-[A-Za-z0-9_-]{16,}/g, "sk-<redacted>"],
  // Id de conversacion: no da acceso sin la cuenta, pero identifica el chat.
  [/(chatgpt\.com\/c\/)[0-9a-f-]{8,}/gi, "$1<redacted>"],
  [/(authorization|api[_-]?key|session[_-]?token|__Secure-[a-z0-9.-]+)["']?\s*[:=]\s*["']?[^\s"',}]{8,}/gi, "$1: <redacted>"],
];

export function sanitizeEvidenceText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Patrones de secreto para auditar artefactos (evidencia/dumps/traces). */
export const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}/,
  /turn_token:\s*(?!<redacted>)[A-Za-z0-9._~+/-]{20,}/,
  /request_id:\s*(?!<redacted>)[A-Za-z0-9._~+/-]{20,}/,
];
