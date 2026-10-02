// stream.ts — M5: wrapper de SSE tolerante al cierre sucio del upstream.
//
// El backend de ChatGPT corta la conexion con reset en lugar de cerrar
// limpio. Si el corte llega DESPUES de `data: [DONE]`, el turno ya entrego
// todo lo que el protocolo define: se cierra normal. Si llega ANTES, el
// turno quedo truncado y el error se propaga (no se inventa un final).
import { UpstreamStreamError } from "./errors";

export const SSE_TERMINATOR = "data: [DONE]";

export function withUncleanCloseTolerance(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let completed = false;
  let bytes = 0;

  const inspect = (text: string): void => {
    lineBuffer += text;
    let newline = lineBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
      lineBuffer = lineBuffer.slice(newline + 1);
      if (line === SSE_TERMINATOR) completed = true;
      newline = lineBuffer.indexOf("\n");
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          const rest = decoder.decode();
          if (rest) inspect(`${rest}\n`);
          controller.close();
          return;
        }
        bytes += value.byteLength;
        inspect(decoder.decode(value, { stream: true }));
        controller.enqueue(value);
      } catch (error) {
        if (completed) {
          controller.close();
          return;
        }
        controller.error(new UpstreamStreamError(bytes, error));
      }
    },
    cancel(reason) {
      completed = true;
      return reader.cancel(reason);
    },
  });
}

/** True si el content-type es un stream SSE. */
export function isEventStream(contentType: string | null): boolean {
  return (contentType ?? "").toLowerCase().includes("text/event-stream");
}
