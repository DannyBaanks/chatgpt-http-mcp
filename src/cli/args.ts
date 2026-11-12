// src/cli/args.ts — Helpers de argumentos e interacción compartidos por los comandos de la CLI.
import readline from "node:readline";

/** Valor de `--name valor` en args (o undefined). */
export function flag(name: string, args: string[]): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Pregunta en la terminal y devuelve la respuesta sin espacios. */
export function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Confirmación s/N. */
export async function confirm(question: string): Promise<boolean> {
  return /^(s|si|sí|y|yes)$/i.test(await ask(`${question} [s/N] `));
}
