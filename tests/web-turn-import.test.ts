import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(resolve(import.meta.dir, "../src/web-turn.ts")).href;

function runIsolatedImport(body: string): string {
  const source = `
    const calls = [];
    Bun.spawnSync = (...args) => {
      calls.push(args[0]);
      return { stdout: Buffer.from("Google Chrome 153.0.0.0"), stderr: Buffer.alloc(0), exitCode: 0 };
    };
    const webTurn = await import(${JSON.stringify(moduleUrl)});
    ${body}
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", source], {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

test("formatChromeUserAgent uses the parsed browser version and fallback", () => {
  const output = JSON.parse(runIsolatedImport(`
    console.log(JSON.stringify([
      webTurn.formatChromeUserAgent("Google Chrome 126.0.6478.126"),
      webTurn.formatChromeUserAgent("not a browser version"),
    ]));
  `)) as string[];

  expect(output).toEqual([
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.126 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  ]);
});

test("importing web-turn does not spawn a process", () => {
  const calls = JSON.parse(runIsolatedImport(`
    console.log(JSON.stringify(calls));
  `)) as unknown[];

  expect(calls).toEqual([]);
});
