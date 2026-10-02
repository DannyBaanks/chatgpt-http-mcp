// errors.ts — taxonomia de errores del bridge (M5).
export type ErrorType =
  | "upstream_unreachable"
  | "upstream_timeout"
  | "upstream_reset_mid_stream"
  | "client_cancelled"
  | "catalog_augment_failed"
  | "not_found"
  | "method_not_allowed"
  | "internal_error";

export function errorJson(status: number, type: ErrorType, message: string): Response {
  return Response.json({ error: { type, message } }, { status });
}

/** Error de stream del upstream, con bytes ya entregados para diagnostico. */
export class UpstreamStreamError extends Error {
  readonly bytes: number;
  readonly type: ErrorType = "upstream_reset_mid_stream";

  constructor(bytes: number, cause: unknown) {
    super(
      `upstream corto el stream tras ${bytes} bytes: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "UpstreamStreamError";
    this.bytes = bytes;
  }
}
