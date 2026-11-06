// provider-block.ts — bloqueos de seguridad de OpenAI: llegan como TEXTO del
// asistente, no como error HTTP. Viven fuera de chat-turn para que la ruta MCP
// los detecte sin cargar web-turn/playwright.
export const PROVIDER_BLOCK_CODE = "provider_blocked";

const PROVIDER_BLOCK_PATTERNS = [
  /bloquead[oa] por los controles de seguridad de OpenAI/i,
  /OpenAI ha bloqueado esta llamada/i,
  /blocked by OpenAI'?s? (?:safety|security)/i,
  /OpenAI (?:has )?blocked this (?:tool )?call/i,
];

export function isProviderBlock(text: string): boolean {
  return PROVIDER_BLOCK_PATTERNS.some((re) => re.test(text));
}
