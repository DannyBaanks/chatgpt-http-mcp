import { existsSync, lstatSync, chmodSync } from "node:fs";
import { join } from "node:path";

let cachedIdentity: string | null = null;

function windowsIdentity(): string {
  if (cachedIdentity) return cachedIdentity;
  const result = Bun.spawnSync(["whoami.exe"], { stdout: "pipe", stderr: "ignore", timeout: 3000 });
  const value = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !value || /[\r\n]/.test(value)) throw Error("private_path_owner_unavailable");
  cachedIdentity = value;
  return value;
}

/** Apply the repo's private 0700/0600 intent with NTFS ACLs on Windows. */
export function securePrivatePath(path: string, directory: boolean, unixMode = directory ? 0o700 : 0o600): void {
  if (process.platform !== "win32") {
    chmodSync(path, unixMode);
    return;
  }
  const root = process.env.SystemRoot ?? "C:\\Windows";
  const icacls = join(root, "System32", "icacls.exe");
  const rights = directory ? "(OI)(CI)F" : "F";
  const result = Bun.spawnSync([
    icacls, path, "/inheritance:r", "/grant:r",
    `${windowsIdentity()}:${rights}`, `*S-1-5-18:${rights}`, `*S-1-5-32-544:${rights}`, "/Q",
  ], { stdout: "ignore", stderr: "ignore", timeout: 8000 });
  if (result.exitCode !== 0) throw Error("private_path_acl_failed");
}

/** Ensure a private directory/file exists and has the platform's private ACL. */
export function ensurePrivatePath(path: string, directory: boolean): void {
  if (!existsSync(path)) throw Error("private_path_missing");
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw Error("private_path_type_invalid");
  if (process.platform === "win32") securePrivatePath(path, directory);
  else if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw Error("private_path_permissions_invalid");
}
