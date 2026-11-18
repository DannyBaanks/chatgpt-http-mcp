import type { CliModule } from "../module";
import { runDash } from "../../dash/app";

const DASH_HELP = `isymcp dash — panel de terminal ISyMCP

  isymcp dash       abre el panel interactivo (q o Ctrl+C para salir)
  isymcp dash --once imprime un frame y sale (útil para pipes y diagnóstico)
`;

export const dashModule: CliModule = {
  names: ["dash"],
  async run(sub, rest) {
    const args = [sub, ...rest].filter((value): value is string => Boolean(value));
    if (args.includes("--help") || args.includes("-h")) {
      console.log(DASH_HELP);
      return;
    }
    await runDash(undefined, { once: args.includes("--once") });
  },
};
