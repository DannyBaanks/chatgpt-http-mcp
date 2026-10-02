#!/usr/bin/env bun
// chatgpt-command.ts — imprime el texto listo para pegar en el composer de
// chatgpt.com con el app Codex ISyMCP elegido.
//
// El texto va primero; el comando @ al final, que es donde el modelo lo lee
// como orden. Si el app no esta seleccionado en el composer, el @ no enruta
// solo: por eso las instructions del MCP (src/mcp/identity.ts) ordenan tratar
// el token como comando.
//
//   bun run scripts/chatgpt-command.ts "revisar el repo y decir que falta"
//   bun run scripts/chatgpt-command.ts "tarea" --turn-token turn_abc --effort high
import { CONNECTOR_NAME, MENTION, buildChatGPTCommand } from "../src/mcp/identity";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const text = process.argv[2];
if (!text) {
  console.error(`uso: bun run scripts/chatgpt-command.ts "<texto>" [--turn-token X] [--effort high]`);
  process.exit(2);
}

const command = buildChatGPTCommand(text, {
  turnToken: argValue("--turn-token"),
  effort: argValue("--effort"),
});

console.log(`# app: ${CONNECTOR_NAME} (seleccionarlo en el composer)`);
console.log(`# token: ${MENTION}\n`);
console.log("--- INICIO DEL TEXTO A PEGAR ---");
console.log(command);
console.log("--- FIN ---");