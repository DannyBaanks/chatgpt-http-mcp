// src/cli/commands/openswift.ts — `isymcp openswift screenshot|devices`: simulador visual de iPhone/iPad (OpenSwift).
import type { CliModule } from "../module";
import { flag } from "../args";
import { captureOpenSwiftScreenshot, listOpenSwiftDevices } from "../../openswift/service";

const HELP = `isymcp openswift — simulador visual de pantallas SwiftUI en iPhone/iPad

  isymcp openswift screenshot <archivo.swift> [opciones]
    --device <id|lista>          ej. iphone-16-pro (default), iphone-14, ipad-pro-11, phones, all
    --appearance <dark|light|both>
    --orientation <portrait|landscape>
    --frame <black|natural|white|blue|none>
    --scale <1..3>               densidad Retina (default 2)
    -o, --output <ruta.png>      ruta de salida del PNG
    --json                       imprime metadatos completos en JSON

  isymcp openswift devices [--json]
    lista todos los modelos de iPhone e iPad soportados`;

export const openswiftModule: CliModule = {
  names: ["openswift", "ios-sim"],
  async run(sub, rest) {
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      console.log(HELP);
      return;
    }

    if (sub === "devices" || sub === "models") {
      const res = listOpenSwiftDevices();
      if (!res.ok) {
        console.error(`✗ ${res.error}`);
        process.exitCode = 1;
        return;
      }
      if (rest.includes("--json")) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      for (const d of res.devices ?? []) {
        console.log(
          `  ${d.id.padEnd(18)} ${d.name.padEnd(20)} ${String(d.width).padStart(4)}×${String(d.height).padEnd(4)}  notch=${d.notch_type}`,
        );
      }
      return;
    }

    if (sub === "screenshot" || sub === "render" || sub === "preview") {
      const positional = rest.filter((a, i) => {
        if (a.startsWith("-")) return false;
        const prev = i > 0 ? rest[i - 1] : "";
        return !["--device", "--appearance", "--orientation", "--frame", "--scale", "-o", "--output", "--source"].includes(prev);
      });
      const file = positional[0];
      const source = flag("--source", rest);
      const device = flag("--device", rest) ?? "iphone-16-pro";
      const appearance = flag("--appearance", rest) ?? "dark";
      const orientation = flag("--orientation", rest) ?? "portrait";
      const frame = flag("--frame", rest) ?? "black";
      const scale = Number(flag("--scale", rest) ?? "2");
      const output = flag("--output", rest) ?? flag("-o", rest);
      const asJson = rest.includes("--json");

      const res = await captureOpenSwiftScreenshot({
        file,
        source,
        device,
        appearance,
        orientation,
        frame,
        scale,
        output,
        include_image: false,
      });

      if (!res.ok) {
        console.error(`✗ ${res.error}`);
        process.exitCode = 1;
        return;
      }

      if (asJson) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`  ✓ PNG:    ${res.png_path} (${res.pixel_width}×${res.pixel_height} px, ${res.raster_engine})`);
        if (res.svg_path) console.log(`  ✓ SVG:    ${res.svg_path}`);
        console.log(`  ✓ SHA256: ${res.sha256}`);
        if (res.problems?.length) {
          console.log(`  ! Avisos (${res.problems.length}): ${res.problems.join("; ")}`);
        }
      }
      return;
    }

    console.error(HELP);
    process.exitCode = 2;
  },
};
