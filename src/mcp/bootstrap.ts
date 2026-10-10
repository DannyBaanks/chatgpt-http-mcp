// The connector guide is local package content, never a caller-supplied path.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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
    sha256: createHash("sha256").update(content).digest("hex"),
    content,
  };
}
