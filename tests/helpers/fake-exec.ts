// fake-exec.ts — ejecutables falsos portables para los tests.
//
// Cada falso es un lanzador con la forma que espera la plataforma + una
// implementacion JS compartida, para no mantener dos comportamientos:
//   Unix     <bin>/<name>       #!/bin/sh -> exec <bun> <impl> "$@"   (0755)
//   Windows  <bin>/<name>.cmd   @echo off -> "<bun>" "<impl>" %*
// En Windows no existe el bit de ejecucion: PATHEXT (.EXE/.CMD/.BAT) es la
// decision de "esto es ejecutable" y Bun.which ya la aplica, asi que el caso
// negativo se expresa sin extension (executable:false).
//
// Dos limites medidos en Windows, que acotan donde sirve un lanzador .cmd:
//   1. node:child_process lanza EINVAL contra .cmd/.bat (mitigacion CVE-2024-27980).
//      Vale solo donde el producto usa Bun.spawn/Bun.spawnSync; lo que pasa por
//      src/media/process.ts o los lanzadores de navegador/codex necesita .exe real.
//   2. Bun se niega (ERR_INVALID_ARG_VALUE) a pasar a un .cmd argumentos que
//      contengan " % & | > ^ o salto de linea. Falla ruidoso, nunca corrupto:
//      espacios, backslash, UNC y globs viajan intactos.
// La implementacion vive en <bin>/impl/, que nunca es resoluble por PATH, para no
// contaminar una deteccion que recorre el propio bin.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export type FakeBody =
  /** stdout fijo (objeto -> JSON en una linea), exit 0. */
  | { print: unknown }
  /** registra la invocacion y opcionalmente responde un JSON segun un token de argv. */
  | { record: { log: string; format?: "argv" | "lines" }; exit?: number;
      respond?: { index: number; equals: string; json: unknown; otherwise: unknown } }
  /** el viejo FAKE de harness.test.ts: `mcp add|remove|unset|list|get` con estado en archivo. */
  | { mcp: { log: string; state: string; server: string } };

export interface FakeOptions {
  /** directorio que va al frente del PATH del proceso hijo. */
  bin: string;
  /** sin extension: "claude", "tunnel-client", "notify-send". */
  name: string;
  body: FakeBody;
  /** false = existe, pero la plataforma no lo considera ejecutable. */
  executable?: boolean;
  /** solo Unix; Windows ignora el modo. */
  mode?: number;
}

export interface Fake {
  name: string;
  /** lo que devuelve resolveExecutable/Bun.which (en Windows trae .cmd). */
  path: string;
  impl: string;
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

function implSource(name: string, body: FakeBody): string {
  const head = 'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";\nconst argv = process.argv.slice(2);\n';
  if ("print" in body) {
    const text = typeof body.print === "string" ? body.print : JSON.stringify(body.print);
    return `${head}process.stdout.write(${JSON.stringify(`${text}\n`)});\n`;
  }
  if ("record" in body) {
    const { log, format = "argv" } = body.record;
    const statement = format === "argv"
      ? `appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");`
      : `writeFileSync(${JSON.stringify(log)}, argv.join("\\n") + "\\n");`;
    const respond = body.respond
      ? `const answer = argv[${body.respond.index}] === ${JSON.stringify(body.respond.equals)} ? ${JSON.stringify(body.respond.json)} : ${JSON.stringify(body.respond.otherwise)};\nif (answer !== undefined) process.stdout.write((typeof answer === "string" ? answer : JSON.stringify(answer)) + "\\n");\n`
      : "";
    return `${head}${statement}\n${respond}process.exit(${body.exit ?? 0});\n`;
  }
  const { log, state, server } = body.mcp;
  // espejo del sh original: log por invocacion, estado por CLI falso, `get` sale 1
  // si el servidor no esta (claude lo usa asi en src/harness.ts).
  return `${head}const NAME = ${JSON.stringify(name)}, SERVER = ${JSON.stringify(server)}, STATE = ${JSON.stringify(state)};
appendFileSync(${JSON.stringify(log)}, NAME + " " + argv.join(" ") + "\\n");
if (argv[0] !== "mcp") process.exit(0);
const rows = () => (existsSync(STATE) ? readFileSync(STATE, "utf8").split("\\n").filter(Boolean) : []);
const save = (list) => writeFileSync(STATE, list.length ? list.join("\\n") + "\\n" : "");
const named = argv.filter((a) => a === SERVER).at(-1) ?? "";
switch (argv[1]) {
  case "add": { if (named) { const list = rows(); if (!list.includes(named)) save([...list, named]); console.log("Added " + named); } break; }
  case "remove": case "unset": { save(rows().filter((r) => r !== named)); console.log("Removed " + named); break; }
  case "list": { for (const row of rows()) console.log(row); console.log("(fin)"); break; }
  case "get": { if (named && rows().includes(named)) { console.log(named + ": stdio"); break; } console.log("No MCP server found"); process.exit(1); }
}
process.exit(0);
`;
}

export function fakeExecutable(options: FakeOptions): Fake {
  const win32 = process.platform === "win32";
  const implDir = join(options.bin, "impl");
  mkdirSync(implDir, { recursive: true });
  const impl = join(implDir, `${options.name}.mjs`);
  const source = implSource(options.name, options.body);
  writeFileSync(impl, source);
  if (options.executable === false) {
    // Unix: regular sin 0o111 -> lo rechaza el check del bit. Windows: sin PATHEXT
    // valida -> Bun.which nunca lo devuelve.
    const decoy = join(options.bin, options.name);
    writeFileSync(decoy, source, { mode: 0o644 });
    if (!win32) chmodSync(decoy, 0o644);
    return { name: options.name, path: decoy, impl };
  }
  const path = win32 ? join(options.bin, `${options.name}.cmd`) : join(options.bin, options.name);
  writeFileSync(path, win32
    // Rutas con join(): cmd.exe cambia el exit code si la ruta lleva barras invertidas normales.
    ? `@echo off\r\n"${process.execPath}" "${impl}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(impl)} "$@"\n`, { mode: options.mode ?? 0o755 });
  if (!win32) chmodSync(path, options.mode ?? 0o755);
  return { name: options.name, path, impl };
}

/** PATH minimo que sigue siendo util: el bin de los falsos primero y lo esencial
 *  del host despues (en Windows hace falta cmd.exe para los lanzadores .cmd y el
 *  directorio de bun para los hijos que invocan `bun` por PATH). */
export function fakePathValue(binDir?: string, extra: string[] = []): string {
  const essential = process.platform === "win32"
    ? [dirname(process.execPath), join(process.env.SystemRoot ?? "C:\\Windows", "System32")]
    : ["/usr/bin", "/bin"];
  return [binDir, ...extra, ...essential].filter(Boolean).join(delimiter);
}

function blockedFromBelow(dir: string): boolean {
  const probe = join(dir, "isymcp-write-probe");
  try { mkdirSync(probe); rmSync(probe, { recursive: true, force: true }); return false; } catch { return true; }
}

/**
 * Nega crear hijos dentro de `dir` como lo expresa cada plataforma (chmod 0555 /
 * icacls /deny). Devuelve el restaurador, o null si este host no lo puede imponer
 * (root en Unix, ACL no aplicable): el test debe salir por su rama de "no
 * demostrable" en vez de pasar sin haber negado nada.
 */
export function denyChildWrites(dir: string): (() => void) | null {
  mkdirSync(dir, { recursive: true });
  if (process.platform !== "win32") {
    if (blockedFromBelow(dir)) return null; // root: ni 0555 frena
    chmodSync(dir, 0o555);
    if (!blockedFromBelow(dir)) { chmodSync(dir, 0o755); return null; }
    return () => chmodSync(dir, 0o755);
  }
  const identity = Bun.spawnSync(["whoami.exe"], { stdout: "pipe", stderr: "ignore", timeout: 3000 }).stdout.toString().trim();
  if (!identity || /[\r\n]/.test(identity)) return null;
  const icacls = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
  const undo = () => Bun.spawnSync([icacls, dir, "/remove:d", identity, "/Q"], { stdout: "ignore", stderr: "ignore", timeout: 8000 });
  const deny = Bun.spawnSync([icacls, dir, "/deny", `${identity}:(OI)(CI)W`, "/Q"], { stdout: "ignore", stderr: "ignore", timeout: 8000 });
  if (deny.exitCode !== 0 || !blockedFromBelow(dir)) { if (deny.exitCode === 0) undo(); return null; }
  return undo;
}
