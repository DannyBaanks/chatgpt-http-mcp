// src/cli/args.ts — Helpers de argumentos e interacción compartidos por los comandos de la CLI.
import readline from "node:readline";

/** Valor de `--name valor` o `--name=valor` en args (o undefined). */
export function flag(name: string, args: string[]): string | undefined {
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === name) {
      const next = args[i + 1];
      return next !== undefined && !next.startsWith("--") ? next : undefined;
    }
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return undefined;
}

/** Pregunta en la terminal y devuelve la respuesta sin espacios. */
export function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const done = (val: string) => {
      if (settled) return;
      settled = true;
      resolve(val.trim());
    };
    rl.once("close", () => done(""));
    rl.question(question, (answer) => {
      rl.close();
      done(answer);
    });
  });
}

/** Confirmación s/N. */
export async function confirm(question: string): Promise<boolean> {
  return /^(s|si|sí|y|yes)$/i.test(await ask(`${question} [s/N] `));
}
