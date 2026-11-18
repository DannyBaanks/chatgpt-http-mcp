// src/openswift/register.ts — Registro de herramientas MCP de OpenSwift iPhone Simulator en ISyMCP.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { captureOpenSwiftScreenshot, listOpenSwiftDevices } from "./service";

export function registerOpenSwiftTools(server: McpServer): void {
  server.registerTool(
    "openswift_screenshot",
    {
      description:
        "Renderiza un archivo .swift o código SwiftUI en línea dentro del simulador visual de iPhone/iPad de OpenSwift y devuelve la captura de pantalla PNG (como imagen visual MCP + ruta en disco + árbol de vistas + problemas detectados) para que el modelo vea exactamente cómo luce la pantalla en un iPhone.",
      inputSchema: {
        file: z
          .string()
          .optional()
          .describe("Ruta al archivo .swift (absoluta, relativa al workspace o relativa a OpenSwift, ej. 'examples/dashboard.swift')."),
        source: z
          .string()
          .optional()
          .describe("Código fuente SwiftUI en línea a renderizar si no se especifica 'file'."),
        device: z
          .string()
          .optional()
          .default("iphone-16-pro")
          .describe(
            "Modelo de iPhone/iPad o lista separada por comas (ej. 'iphone-16-pro', 'iphone-14', 'iphone-12,iphone-16-pro', 'ipad-pro-11', o presets 'phones', 'ipads', 'all').",
          ),
        appearance: z
          .enum(["dark", "light", "both"])
          .optional()
          .default("dark")
          .describe("Modo de color de iOS: 'dark', 'light', o 'both' (genera comparativa lado a lado oscuro + claro)."),
        orientation: z
          .enum(["portrait", "landscape"])
          .optional()
          .default("portrait")
          .describe("Orientación del dispositivo: 'portrait' (vertical) o 'landscape' (horizontal)."),
        frame: z
          .enum(["black", "natural", "white", "blue", "none"])
          .optional()
          .default("black")
          .describe("Color del bisel/carcasa del iPhone, o 'none' para exportar solo la pantalla sin marco."),
        scale: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional()
          .default(2)
          .describe("Factor de escala Retina del PNG (1..3, por defecto 2)."),
        output: z
          .string()
          .optional()
          .describe("Ruta opcional donde guardar el archivo PNG generado."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const res = await captureOpenSwiftScreenshot({
        file: input.file,
        source: input.source,
        device: input.device,
        appearance: input.appearance,
        orientation: input.orientation,
        frame: input.frame,
        scale: input.scale,
        output: input.output,
        include_image: true,
      });
      if (!res.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: res.error }, null, 2) }],
          isError: true,
        };
      }
      const { _mcp_image, ...meta } = res;
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(meta, null, 2) },
          ...(_mcp_image ? [{ type: "image" as const, data: _mcp_image.data, mimeType: _mcp_image.mimeType }] : []),
        ],
      };
    },
  );
}
