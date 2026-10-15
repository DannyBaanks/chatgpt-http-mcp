import { existsSync } from "node:fs";
import { join } from "node:path";

export function defaultBrowserExecutable(): string {
  const configured = process.env.CODEX_WEB_HTTP_CHROME?.trim() || process.env.CHROME_PATH?.trim();
  if (configured) return configured;
  if (process.platform !== "win32") return "/usr/bin/google-chrome";
  const candidates = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find(existsSync) ?? "";
}
