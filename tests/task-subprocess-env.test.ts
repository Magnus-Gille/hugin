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

  it("scrubs the secret from the Pi harness and operational subprocesses", () => {
    const sources = [
      "src/artifact-delivery.ts",
      "src/orchestrator/worker-executor.ts",
      "src/task-helpers.ts",
    ].map((relativePath) =>
      readFileSync(path.join(__dirname, "..", relativePath), "utf8"),
    );

    for (const source of sources) {
      expect(source).toContain("buildTaskSubprocessEnv()");
    }

    const indexSource = readFileSync(
      path.join(__dirname, "..", "src", "index.ts"),
      "utf8",
    );
    const pgrepStart = indexSource.indexOf('spawn("pgrep"');
    const pgrepEnd = indexSource.indexOf("});", pgrepStart);
    expect(indexSource.slice(pgrepStart, pgrepEnd)).toContain(
      "env: buildTaskSubprocessEnv()",
    );
  });
});
