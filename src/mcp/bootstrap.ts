// The connector guide is local package content, never a caller-supplied path.
import { readFileSync } from "node:fs";
import { sha256Hex } from "../crypto";

export interface McpBootstrap {
  name: "ISyMCP MCP bootstrap";
  version: "1";
  sha256: string;
  content: string;
}
export function readMcpBootstrap(): McpBootstrap {
  const content = readFileSync(new URL("./SKILL.md", import.meta.url), "utf8");
  if (!content.trim() || Buffer.byteLength(content) > 16 * 1024) {
    throw new Error("local MCP guide is empty or exceeds 16 KiB");
  }
  return {
    name: "ISyMCP MCP bootstrap",
    version: "1",
    sha256: sha256Hex(content),
    content,
  };
}
