// src/cli/root.ts — Raíz del repo (los comandos la usan para rutas y para relanzar isymcp).
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..", "..");
