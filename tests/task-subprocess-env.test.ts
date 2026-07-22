import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTaskSubprocessEnv,
  SENSITIVITY_CHECKPOINT_SECRET_ENV,
} from "../src/task-subprocess-env.js";

describe("task subprocess environment", () => {
  it("removes the dispatcher-only checkpoint secret and preserves ordinary values", () => {
    expect(buildTaskSubprocessEnv({
      PATH: "/usr/bin",
      [SENSITIVITY_CHECKPOINT_SECRET_ENV]: "hugin-only-secret",
    } as NodeJS.ProcessEnv)).toEqual({ PATH: "/usr/bin" });
  });

  it("the Codex task spawn uses the scrubbed environment helper", () => {
    const source = readFileSync(
      path.join(__dirname, "..", "src", "index.ts"),
      "utf8",
    );
    const start = source.indexOf("function spawnRuntime(");
    const end = source.indexOf("async function", start);
    const spawnRuntime = source.slice(start, end);
    expect(spawnRuntime).toContain("...buildTaskSubprocessEnv()");
    expect(spawnRuntime).not.toContain("...process.env");
  });
});
