// hooks.ts — placeholders. No se listan en el menu.
// Un hook registrado corre antes/despues de la accion con el mismo id.
// Si no hay registro, no hace nada y no imprime nada.
type Hook = (id: string) => void | Promise<void>;

const registry = new Map<string, Hook>();

export function registerHook(id: string, hook: Hook): void {
  registry.set(id, hook);
}

export async function runHook(id: string): Promise<void> {
  const hook = registry.get(id);
  if (hook) await hook(id);
}

export function registeredHookIds(): string[] {
  return [...registry.keys()];
}
