// tool-protocol-probe.ts — experimento barato: acepta ChatGPT Web el sobre de
// funciones externas? (el cliente lo ejecuta; el modelo solo lo pide).
import { sendWebTurn } from "../src/web-turn";
import { homedir } from "node:os";
import { join } from "node:path";

const prompt = [
  "[PROTOCOLO DE FUNCIONES EXTERNAS — IMPORTANTE]",
  "Este chat no tiene herramientas nativas, pero esta conectado a un CLIENTE EXTERNO (ISyCode) que si puede ejecutar funciones en la computadora del usuario.",
  "El cliente parsea tu respuesta: cuando necesites una funcion, responde UNICAMENTE con este JSON, sin texto adicional y sin cercas de codigo:",
  "",
  '{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_time","arguments":"{}"}}]}',
  "",
  "El cliente la ejecutara y en el SIGUIENTE mensaje te devolvera el resultado con el formato:",
  'tool (call_1): {"time":"14:55:00"}',
  "",
  "Nunca digas que no tienes acceso; el cliente externo ejecuta la funcion por ti.",
  "",
  "Funciones disponibles:",
  "- get_time: devuelve la hora local del usuario. Parametros: {} (sin argumentos).",
  "",
  "Pregunta del usuario: ¿que hora es? Usa get_time.",
].join("\n");

const result = await sendWebTurn(prompt, {
  statePath: join(homedir(), ".codex-web-http", "storage-state.json"),
  deadlineMs: 120_000,
});
console.log("submitted:", result.submitted, "ms:", result.ms);
console.log("--- respuesta del modelo ---");
console.log(result.text);
