import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { shouldStartDispatcherFromMain } from "../src/main.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const indexUrl = pathToFileURL(resolve(root, "src/index.ts")).href;
const mainUrl = pathToFileURL(resolve(root, "src/main.ts")).href;

function importModuleWithoutVitest(moduleUrl: string): string {
  const env = { ...process.env };
  delete env.VITEST;
  env.MUNIN_API_KEY ??= "test-key";

  return execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(moduleUrl)}); process.stdout.write("IMPORTED");`,
    ],
    {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 5_000,
    },
  );
}

describe("dispatcher main entrypoint", () => {
  it("starts only when the main entrypoint file is executed directly", () => {
    const mainPath = resolve(root, "src/main.ts");
    expect(shouldStartDispatcherFromMain(pathToFileURL(mainPath).href, mainPath)).toBe(true);
    expect(
      shouldStartDispatcherFromMain(pathToFileURL(mainPath).href, resolve(root, "src/index.ts")),
    ).toBe(false);
    expect(shouldStartDispatcherFromMain(pathToFileURL(mainPath).href, undefined)).toBe(false);
  });

  it("keeps src/index.ts import-safe even when VITEST is absent", () => {
    expect(importModuleWithoutVitest(indexUrl)).toContain("IMPORTED");
  });

  it("keeps src/main.ts import-safe when it is imported instead of executed", () => {
    expect(importModuleWithoutVitest(mainUrl)).toContain("IMPORTED");
  });
});
